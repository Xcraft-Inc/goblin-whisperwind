// @ts-check
const os = require('node:os');
const {parentPort, workerData} = require('worker_threads');
const {calcRMS} = require('../utils.js');

/**
 * Job envoyé par le scheduler (Option B).
 *
 * @typedef {Object} TranscribeJob
 * @property {string} jobId         - Identifiant unique pour ce job.
 * @property {string} sessionId     - ID de session côté serveur.
 * @property {number} segmentIndex  - Index de segment (équiv. chunkIndex local).
 * @property {string} language      - Code langue (ex: 'fr', 'en', 'auto').
 * @property {boolean} isLast       - Indique si c'est le dernier segment (flush final).
 * @property {number} durationSec   - Durée réelle du segment en secondes (sans le padding).
 * @property {ArrayBuffer} audio    - Audio en Float32Array.buffer (mono, 16kHz).
 */

let whisperInstance = null;

// On reprend ta config locale
const params = new WhisperFullParams(WhisperSamplingStrategy.BeamSearch);
params.beamSize = 2;
params.bestOf = 2;
//params.translate = true;
params.nThreads = Math.max(1, os.cpus().length - 1);
params.language = 'fr';
params.noContext = true;
params.singleSegment = false;
params.suppressBlank = true;
params.debugMode = false;
params.noSpeechThreshold = 0.6;
params.suppressNonSpeechTokens = true;
params.temperature = 0.0;
params.lengthPenalty = -1.0;

/**
 * Initialise Whisper sur le GPU avec le modèle fourni.
 * @returns {Promise<void>}
 */
async function initWhisper() {
  if (whisperInstance) return;
  const modelPath = workerData?.modelPath;
  if (!modelPath) {
    throw new Error('Missing modelPath in workerData');
  }

  whisperInstance = new Whisper(modelPath, {
    useGpu: false,
    flashAttn: true,
  });
}

/**
 * Applique un traitement
 *  - RMS
 *  - gain adaptatif
 *  - clamp [-1, 1]
 *
 * @param {Float32Array} segment
 */
function applyGain(segment) {
  const rmsValue = calcRMS(segment);
  let gain = 1.0;
  if (rmsValue < 0.02) gain = 4.0;
  else if (rmsValue < 0.05) gain = 2.0;

  for (let i = 0; i < segment.length; i++) {
    const v = segment[i] * gain;
    // clamp [-1, 1]
    segment[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
}

/**
 * Effectue la transcription d'un job audio.
 * On reproduit la logique de ton runWhisperAsync :
 *  - set durationMs = job.durationSec * 1000
 *  - set language (si fourni)
 *  - onNewSegment -> concat texte
 *
 * @param {TranscribeJob} job - Job à traiter.
 * @returns {Promise<string>} - Texte transcrit.
 */
async function transcribeJob(job) {
  if (!whisperInstance) {
    await initWhisper();
  }

  const float32 = new Float32Array(job.audio);

  // 1) Traitement RMS/gain comme dans ton recorder local
  applyGain(float32);

  // 2) Paramètres Whisper
  params.language = job.language || 'fr';
  params.offsetMs = 0;
  params.durationMs = Math.round(
    (job.durationSec || float32.length / 16000) * 1000
  );

  return whisperInstance.full(params, float32);
}

/**
 * Point d'entrée principal pour les messages du parent.
 */
parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') {
    return;
  }

  switch (msg.type) {
    case 'init': {
      try {
        await initWhisper();
        parentPort.postMessage({type: 'ready'});
      } catch (err) {
        parentPort.postMessage({
          type: 'error',
          message: err.message || 'Failed to init Whisper',
        });
      }
      break;
    }

    case 'transcribe': {
      /** @type {TranscribeJob} */
      const job = msg.job;
      if (!job) {
        parentPort.postMessage({
          type: 'error',
          message: 'Missing job in transcribe message',
        });
        return;
      }

      try {
        const text = await transcribeJob(job);
        parentPort.postMessage({
          type: 'result',
          jobId: job.jobId,
          sessionId: job.sessionId,
          segmentIndex: job.segmentIndex,
          text,
          isLast: job.isLast,
        });
      } catch (err) {
        parentPort.postMessage({
          type: 'error',
          jobId: job.jobId,
          sessionId: job.sessionId,
          message: err.message || 'Transcription error',
        });
      }
      break;
    }

    default:
      parentPort.postMessage({
        type: 'error',
        message: `Unknown message type: ${msg.type}`,
      });
  }
});
