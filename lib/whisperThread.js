const {Worker} = require('node:worker_threads');
const path = require('path');
const {
  targetSampleRate,
  frameSize,
  segmentSec,
  maxBufferSec,
  modelsSourceRepo,
  modelsSourcePrefix,
  remoteWindServerUrl,
} = require('xcraft-core-etc')().load('goblin-whisperwind');

class WhisperThread {
  constructor(logger) {
    this.logger = logger;
    this.worker = new Worker(path.join(__dirname, 'whisperWorker.js'));
    this.options = {
      targetSampleRate,
      frameSize,
      segmentSec,
      maxBufferSec,
      remoteWindServerUrl,
    };

    this.requestId = 0;
    this.pendingRequests = new Map();

    this.worker.on('message', (event) => {
      const {id, type, msg, error, ...rest} = event;

      // Logs “live” depuis le worker
      if (type === 'log' && this.logger) {
        this.logger(msg);
        return;
      }

      // Réponse liée à une requête
      const pending = this.pendingRequests.get(id);
      if (pending) {
        const {resolve, reject, cleanup} = pending;

        if (type === 'error') reject(new Error(error));
        else resolve(rest);

        cleanup();
      }
    });

    this.worker.on('error', (err) => {
      console.error('❌ Whisper worker error:', err);
    });

    this.worker.on('exit', (code) => {
      console.log(`💀 Whisper worker exited (${code})`);
    });
  }

  _send(command, args = {}, options = {}, {signal, timeoutMs = 30000} = {}) {
    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      let timer = null;

      const cleanup = () => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
      };

      this.pendingRequests.set(id, {resolve, reject, cleanup});

      // Timeout automatique
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.worker.postMessage({id, command: 'abort', reason: 'timeout'});
          reject(
            new Error(`Timeout after ${timeoutMs}ms on command ${command}`)
          );
          cleanup();
        }, timeoutMs);
      }

      // AbortSignal
      if (signal) {
        if (signal.aborted) {
          reject(new Error('Aborted before sending command'));
          cleanup();
          return;
        }
        const onAbort = () => {
          this.worker.postMessage({id, command: 'abort', reason: 'signal'});
          reject(new Error(`Aborted during ${command}`));
          cleanup();
        };
        signal.addEventListener('abort', onAbort, {once: true});
      }

      // Envoi
      this.worker.postMessage({id, command, args, options});
    });
  }

  installModel(model, modelFilePath, {signal} = {}) {
    const xFs = require('xcraft-core-fs');
    const xConfig = require('xcraft-core-etc')().load('xcraft');
    const modelsRoot = path.join(xConfig.xcraftRoot, 'var/whisperwind');
    xFs.mkdir(modelsRoot);

    return this._send(
      'install',
      {
        modelsRoot,
        modelFilePath,
        modelsSourceRepo,
        modelsSourcePrefix,
        model,
      },
      {},
      {signal, timeoutMs: 0}
    );
  }

  init(modelFilePath, mode, {signal} = {}) {
    this.options.modelFilePath = modelFilePath;
    this.options.mode = mode;
    return this._send('init', {}, this.options, {signal});
  }

  start(sessionId, deviceIndex, {signal} = {}) {
    return this._send(
      'start',
      {sessionId, deviceIndex},
      {},
      {signal, timeoutMs: 0}
    );
  }

  stop({signal} = {}) {
    return this._send('stop', {}, {}, {signal});
  }

  async terminate() {
    await this.worker.terminate();
  }
}

module.exports = WhisperThread;
