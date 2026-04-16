// @ts-check
/**
 * Représente l'état d'une session côté scheduler.
 *
 * On copie la logique de WhisperRecorder local :
 *  - buffer audio continu en 16kHz
 *  - processedSamples (curseur en samples 16k)
 *  - SEGMENT_SAMPLES = 30s
 *  - dernier segment paddé avec du silence, mais avec realSec séparé
 *
 * @typedef {Object} SchedulerSessionState
 * @property {string} sessionId
 * @property {string|null} clientSessionId
 * @property {string} language
 * @property {Float32Array} buffer16k - Buffer audio continu 16kHz.
 * @property {number} processedSamples - Index (en samples 16kHz) jusqu'où on a découpé.
 * @property {number} segmentIndex - Compteur de segments (équiv. chunkIndex local).
 * @property {boolean} jobInFlight - Job GPU en cours pour cette session.
 * @property {boolean} finalFlushRequested - STOP reçu (il faut traiter la "queue").
 * @property {string} lastText - Dernier texte complet renvoyé.
 * @property {import('./gateway.js').SendTranscript} sendTranscript
 */

/**
 * Scheduler qui gère l'audio par session et envoie les jobs au worker Whisper.
 * Implémente Option B = comportement aligné sur ton WhisperRecorder local.
 */
class TranscriptionScheduler {
  /**
   * @param {Worker} worker - Worker thread qui exécute Whisper.
   * @param {Function} logger - Logger simple.
   */
  constructor(worker, logger) {
    this.worker = worker;
    /** @type {Map<string, SchedulerSessionState>} */
    this.sessions = new Map();
    /** @type {Map<string, string>} jobId -> sessionId */
    this.jobToSession = new Map();
    this.logger = logger;
    this.jobSeq = 0;

    this.TARGET_SAMPLE_RATE = 16000;
    this.SEGMENT_SEC = 30;
    this.SEGMENT_SAMPLES = this.TARGET_SAMPLE_RATE * this.SEGMENT_SEC;

    this.MAX_BUFFER_SEC = 120;
    this.MAX_BUFFER_SAMPLES = this.TARGET_SAMPLE_RATE * this.MAX_BUFFER_SEC;

    this.worker.on('message', (msg) => {
      void this.onWorkerMessage(msg);
    });

    this.worker.on('error', (err) => {
      this.logger.error('Whisper worker error', {err});
    });

    this.worker.on('exit', (code) => {
      this.logger.error('Whisper worker exited', {code});
    });

    // Demande d'init du worker (chargement modèle)
    this.worker.postMessage({type: 'init'});
  }

  /**
   * Crée et enregistre l'état d'une nouvelle session.
   *
   * @param {string} sessionId
   * @param {string|null} clientSessionId
   * @param {string} language
   * @param {import('./gateway.js').SendTranscript} sendTranscript
   */
  startSession(sessionId, clientSessionId, language, sendTranscript) {
    /** @type {SchedulerSessionState} */
    const state = {
      sessionId,
      clientSessionId,
      language,
      buffer16k: new Float32Array(0),
      processedSamples: 0,
      segmentIndex: 0,
      jobInFlight: false,
      finalFlushRequested: false,
      lastText: '',
      sendTranscript,
    };
    this.sessions.set(sessionId, state);
    this.logger(`Scheduler: session started ${sessionId} ${language}`);
  }

  /**
   * Ajoute un chunk audio 16kHz à la session et déclenche
   * la découpe en segments de 30s exactement comme le recorder local.
   *
   * @param {string} sessionId
   * @param {Float32Array} float32 - Audio 16kHz mono
   * @param {boolean} isLast - STOP demandé (flush final).
   */
  pushAudio(sessionId, float32, isLast) {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // 1) Append du chunk au buffer continu 16k
    if (float32.length > 0) {
      const combined = new Float32Array(
        state.buffer16k.length + float32.length
      );
      combined.set(state.buffer16k);
      combined.set(float32, state.buffer16k.length);
      state.buffer16k = combined;

      // Limite de buffer comme dans le recorder local (en 16k)
      if (state.buffer16k.length > this.MAX_BUFFER_SAMPLES) {
        const overflow = state.buffer16k.length - this.MAX_BUFFER_SAMPLES;
        state.buffer16k = state.buffer16k.slice(overflow);
        state.processedSamples = Math.max(0, state.processedSamples - overflow);
      }
    }

    if (isLast) {
      state.finalFlushRequested = true;
    }

    // 2) Tente de planifier des segments comme dans la boucle while locale
    this.processAvailableSegments(state);
  }

  /**
   * Essaie de découper et planifier des segments 30s (ou le tail final)
   * pour une session donnée, tant qu'il n'y a pas de job en vol.
   *
   * @param {SchedulerSessionState} state
   */
  processAvailableSegments(state) {
    if (state.jobInFlight) return;

    const totalSamples = state.buffer16k.length;
    const processedSamples = state.processedSamples;
    const remaining = totalSamples - processedSamples;

    if (remaining <= 0) {
      return;
    }

    // Bloc complet de 30s ?
    if (remaining >= this.SEGMENT_SAMPLES) {
      this.scheduleRegularSegment(state);
      return;
    }

    // Tail final si STOP et reste du son
    if (state.finalFlushRequested && remaining > 0) {
      this.scheduleTailSegment(state);
      return;
    }
  }

  /**
   * Planifie un segment "normal" de 30s (exactement SEGMENT_SAMPLES),
   * comme dans ta boucle while locale.
   *
   * @param {SchedulerSessionState} state
   */
  scheduleRegularSegment(state) {
    const {buffer16k} = state;
    const start = state.processedSamples;
    const end = start + this.SEGMENT_SAMPLES;

    const segment = buffer16k.slice(start, end);
    const realSec = segment.length / this.TARGET_SAMPLE_RATE; // ~30s

    state.processedSamples += this.SEGMENT_SAMPLES;
    const segmentIndex = ++state.segmentIndex;

    const jobId = `job-${++this.jobSeq}`;
    state.jobInFlight = true;
    this.jobToSession.set(jobId, state.sessionId);

    const job = {
      jobId,
      sessionId: state.sessionId,
      language: state.language,
      segmentIndex,
      durationSec: realSec,
      isLast: false,
      audio: segment.buffer,
    };

    this.logger('Scheduler: regular segment scheduled');
    this.worker.postMessage({type: 'transcribe', job});
  }

  /**
   * Planifie le dernier segment (tail) :
   *  - on prend tout ce qui reste après processedSamples
   *  - on pad avec du silence pour atteindre SEGMENT_SAMPLES
   *  - on indique isLast = true et durationSec = durée réelle NON paddée
   *
   * @param {SchedulerSessionState} state
   */
  scheduleTailSegment(state) {
    const {buffer16k} = state;
    const start = state.processedSamples;
    const tail = buffer16k.slice(start);
    const tailLen = tail.length;
    const realSec = tailLen / this.TARGET_SAMPLE_RATE;

    const paddedLength = Math.max(tailLen, this.SEGMENT_SAMPLES);
    const padded = new Float32Array(paddedLength);
    padded.set(tail);

    state.processedSamples += tailLen;
    const segmentIndex = ++state.segmentIndex;

    const jobId = `job-${++this.jobSeq}`;
    state.jobInFlight = true;
    this.jobToSession.set(jobId, state.sessionId);

    const job = {
      jobId,
      sessionId: state.sessionId,
      language: state.language,
      segmentIndex,
      durationSec: realSec,
      isLast: true,
      audio: padded.buffer,
    };

    this.logger(`Scheduler: tail segment scheduled (final)`);

    this.worker.postMessage({type: 'transcribe', job});
  }

  /**
   * Termine une session côté scheduler (cleanup).
   *
   * @param {string} sessionId
   */
  endSession(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    this.logger(`Scheduler: session ended (cleanup) ${sessionId}`);
  }

  /**
   * Gère les messages en provenance du worker Whisper.
   *
   * @param {any} msg
   */
  async onWorkerMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return;
    }

    switch (msg.type) {
      case 'ready':
        this.logger('Whisper worker ready');
        break;

      case 'error':
        this.logger('Error from Whisper worker');
        break;

      case 'result':
        await this.onJobResult(msg);
        break;

      default:
        this.logger('Unknown message from worker');
    }
  }

  /**
   * Traite le résultat d'un job de transcription.
   *
   * @param {{ jobId: string, sessionId: string, segmentIndex: number, text: string, isLast: boolean }} msg
   */
  async onJobResult(msg) {
    const {jobId, sessionId, segmentIndex, text, isLast} = msg;

    this.jobToSession.delete(jobId);

    const state = this.sessions.get(sessionId);
    if (!state) {
      // Session déjà fermée
      return;
    }

    state.jobInFlight = false;

    const newText = text || '';
    state.lastText = newText;

    await state.sendTranscript({
      text: newText,
      isFinal: isLast,
      extra: {segmentIndex},
    });

    if (isLast) {
      this.logger('Scheduler: final result received');
      this.endSession(sessionId);
      return;
    }

    // Si on a encore du son non traité, on tente de planifier le segment suivant
    this.processAvailableSegments(state);
  }
}

module.exports = TranscriptionScheduler;
