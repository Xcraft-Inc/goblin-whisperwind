const os = require('node:os');
const {resampleTo16kHz, calcRMS, buildRtAudio} = require('./utils.js');

const {
  Whisper,
  WhisperFullParams,
  WhisperSamplingStrategy,
} = require('@napi-rs/whisper');

class WhisperRecorder {
  constructor(options = {}, logger) {
    this.modelPath = options.modelFilePath;
    this.logger = logger;

    this.TARGET_SAMPLE_RATE = options.targetSampleRate || 16000;
    this.FRAME_SIZE = options.frameSize || 1920;
    this.SEGMENT_SEC = options.segmentSec || 30;
    this.MAX_BUFFER_SEC = options.maxBufferSec || 120;
    this.SEGMENT_SAMPLES = this.TARGET_SAMPLE_RATE * this.SEGMENT_SEC;
    this.MAX_BUFFER_SAMPLES = this.TARGET_SAMPLE_RATE * this.MAX_BUFFER_SEC;
    this.LOG_TICK_INTERVAL = 5000;

    this.whisper = new Whisper(this.modelPath, {
      useGpu: true,
      flashAttn: true,
    });

    // --- Param Whisper ---
    this.params = new WhisperFullParams(WhisperSamplingStrategy.BeamSearch);
    this.params.beamSize = 2;
    this.params.bestOf = 2;
    this.params.nThreads = Math.max(1, os.cpus().length - 1);
    this.params.language = 'fr';
    this.params.noContext = true;
    this.params.singleSegment = false;
    this.params.suppressBlank = true;
    this.params.debugMode = false;
    this.params.noSpeechThreshold = 0.6;
    this.params.suppressNonSpeechTokens = true;
    this.params.temperature = 0.0;
    this.params.lengthPenalty = -1.0;

    this.rtAudio = buildRtAudio();
    this.devices = this.rtAudio.getDevices();

    // --- État dynamique ---
    this.currentBuffer = new Float32Array(0);
    this.processedSamples = 0;
    this.processing = false;
    this.chunkIndex = 0;
    this.totalCapturedSec = 0;
    this.pendingTranscriptions = [];
    this.isRunning = false;

    this.transcript = {
      sessionId: '',
      createdAt: new Date().toISOString(),
      startedAt: null,
      device: '',
      sampleRate: 0,
      segments: [],
      state: {
        totalDuration: 0,
        segmentsCount: 0,
        finalized: false,
      },
    };
  }

  log(msg) {
    if (this.logger) {
      this.logger(msg);
    }
  }

  getDevices() {
    return this.devices;
  }

  // --- Start recording ---
  async start(sessionId, deviceIndex) {
    const device = this.devices[deviceIndex];
    if (!device || device.inputChannels === 0)
      throw new Error('❌ Périphérique invalide.');

    const inputSampleRate = device.preferredSampleRate || 48000;
    this.transcript.device = device.name;
    this.transcript.sampleRate = inputSampleRate;
    this.transcript.startedAt = new Date().toISOString();
    this.transcript.sessionId = sessionId;

    this.log(`🎧 Capture depuis : ${device.name} (${inputSampleRate} Hz)`);

    const frameSize = Math.floor((this.FRAME_SIZE * inputSampleRate) / 48000);
    let lastTick = Date.now();

    const {RtAudioFormat} = require('xcraft-audify');
    this.rtAudio.openStream(
      null,
      {deviceId: device.id, nChannels: 1, firstChannel: 0},
      RtAudioFormat.RTAUDIO_FLOAT32,
      inputSampleRate,
      frameSize,
      'Stream',
      async (pcmBuffer) => {
        if (!this.isRunning) {
          return;
        }

        const samples = new Float32Array(
          pcmBuffer.buffer,
          pcmBuffer.byteOffset,
          pcmBuffer.byteLength / 4
        );

        const combined = new Float32Array(
          this.currentBuffer.length + samples.length
        );
        combined.set(this.currentBuffer);
        combined.set(samples, this.currentBuffer.length);
        this.currentBuffer = combined;

        const maxSamples =
          this.MAX_BUFFER_SAMPLES * (inputSampleRate / this.TARGET_SAMPLE_RATE);
        if (this.currentBuffer.length > maxSamples) {
          const overflow = this.currentBuffer.length - maxSamples;
          this.currentBuffer = this.currentBuffer.slice(overflow);
          this.processedSamples = Math.max(0, this.processedSamples - overflow);
        }

        const nowTick = Date.now();
        if (nowTick - lastTick > this.LOG_TICK_INTERVAL) {
          const duration = (
            this.currentBuffer.length / inputSampleRate
          ).toFixed(1);
          this.log(`⏱️  Capture active (${duration}s en buffer)`);
          lastTick = nowTick;
        }

        const resampled = resampleTo16kHz(
          this.currentBuffer,
          inputSampleRate,
          this.TARGET_SAMPLE_RATE
        );

        while (
          resampled.length - this.processedSamples >= this.SEGMENT_SAMPLES &&
          !this.processing
        ) {
          const segment = resampled.slice(
            this.processedSamples,
            this.processedSamples + this.SEGMENT_SAMPLES
          );
          this.processedSamples += this.SEGMENT_SAMPLES;
          this.processing = true;
          const p = this.transcribeSegment(segment);
          this.pendingTranscriptions.push(p);
          await p;
          this.processing = false;
        }
      }
    );

    this.rtAudio.start();
    this.isRunning = true;
    this.log('🚀 Capture Whisper démarrée.');
  }

  // --- Stop recording and finalize ---
  async stop() {
    if (!this.isRunning) {
      return;
    }
    this.log('\n🛑 Fin de la capture → transcription finale…');
    this.isRunning = false;
    this.rtAudio.closeStream();
    this.rtAudio.stop();

    const resampled = resampleTo16kHz(
      this.currentBuffer,
      this.transcript.sampleRate,
      this.TARGET_SAMPLE_RATE
    );
    const tail = resampled.slice(this.processedSamples);
    const realSec = tail.length / this.TARGET_SAMPLE_RATE;

    if (realSec > 0) {
      this.log(`🎧 Dernier segment: ${realSec.toFixed(2)}s réels`);
      const paddedLength = Math.max(tail.length, this.SEGMENT_SAMPLES);
      const padded = new Float32Array(paddedLength);
      padded.set(tail);

      this.params.noSpeechThreshold = 0.0;
      const p = this.transcribeSegment(padded, true, realSec);
      this.pendingTranscriptions.push(p);
      await p;
    } else {
      this.log('🕳️ Aucun son restant à transcrire.');
    }

    this.log('⏳ Attente de la fin des transcriptions...');
    await Promise.all(this.pendingTranscriptions);

    this.finalizeTranscript();
    return this.formatSimpleTranscript(this.transcript);
  }

  // --- Segment transcription ---
  async transcribeSegment(segment, isFinal = false, realSecOverride = null) {
    const idx = ++this.chunkIndex;
    const realSec = realSecOverride ?? segment.length / this.TARGET_SAMPLE_RATE;
    const tag = isFinal ? '(final)' : '';
    const startSec = this.totalCapturedSec;
    this.totalCapturedSec += realSec;

    this.log(
      `🧠 Début traitement #${idx} ${tag} (${realSec.toFixed(2)}s réels)`
    );

    const rmsValue = calcRMS(segment);
    let gain = 1.0;
    if (rmsValue < 0.02) gain = 4.0;
    else if (rmsValue < 0.05) gain = 2.0;
    for (let i = 0; i < segment.length; i++) {
      segment[i] = Math.max(-1, Math.min(1, segment[i] * gain));
    }

    this.params.offsetMs = 0;
    this.params.durationMs = realSec * 1000;

    const durationMs = await this.runWhisperAsync(segment, idx, startSec);
    console.info(
      `🗣️  Segment #${idx} terminé en ${(durationMs / 1000).toFixed(2)} s`
    );
  }

  runWhisperAsync(segment, idx, baseStartSec) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let progressDone = false;

      this.params.onNewSegment = (s) => {
        if (!s?.text) return;
        const cleanText = s.text.replace(/\s+/g, ' ').trim();

        if (cleanText === '...') {
          return;
        }

        const rawSegment = {
          chunkIndex: idx,
          chunkStartSec: baseStartSec,
          whisper: {...s, text: cleanText},
        };

        this.transcript.segments.push(rawSegment);
        this.log(
          `🧩 ${cleanText} [Whisper segment: start=${s.start.toFixed(
            2
          )}s, end=${s.end.toFixed(2)}s, chunk=${idx}]`
        );
      };

      this.params.onProgress = (p) => {
        if (p >= 100 && !progressDone) {
          progressDone = true;
          const durationMs = Date.now() - startTime;
          resolve(durationMs);
        }
      };

      this.whisper.full(this.params, segment);

      setTimeout(() => {
        if (!progressDone) {
          progressDone = true;
          const durationMs = Date.now() - startTime;
          console.warn(`⚠️ Timeout 40s → forçage de fin sur segment #${idx}`);
          resolve(durationMs);
        }
      }, 40000);
    });
  }

  finalizeTranscript() {
    this.transcript.state.totalDuration = this.totalCapturedSec;
    this.transcript.state.segmentsCount = this.transcript.segments.length;
    this.transcript.state.finalized = true;
  }

  formatSimpleTranscript(data) {
    return {
      sessionId: data.sessionId,
      startedAt: data.startedAt,
      transcripts: data.segments.map((s) => {
        return {
          text: s.whisper.text,
        };
      }),
    };
  }
}

module.exports = WhisperRecorder;
