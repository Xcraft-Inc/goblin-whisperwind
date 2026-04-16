'use strict';

const os = require('node:os');
const {resampleTo16kHz} = require('./utils.js');
const WebSocket = require('ws');

class WhisperRecorderRemote {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - API key pour le service
   * @param {string} [options.language='fr'] - Langue à demander au serveur
   * @param {number} [options.targetSampleRate=16000] - Doit matcher FIXED_SAMPLE_RATE côté serveur
   * @param {number} [options.frameSize=1920] - Frame RtAudio de base (à 48k → ~40ms)
   * @param {(evt: {text:string, isFinal:boolean, timestamp:number, segmentIndex?:number, raw:any}) => void} [options.onTranscript]
   * @param {(msg:string) => void} [logger]
   */
  constructor(options = {}, logger) {
    this.wsUrl =
      options.remoteWindServerUrl || 'ws://127.0.0.1:3000/ws/transcribe';
    this.apiKey = options.apiKey || 'wind-key';
    this.language = options.language || 'fr';

    this.TARGET_SAMPLE_RATE = options.targetSampleRate || 16000;
    this.FRAME_SIZE = options.frameSize || 1920; // frame RtAudio à 48k → ~40ms
    this.MAX_BUFFER_SEC = options.maxBufferSec || 120; // juste pour info/log si besoin

    this.onTranscript = options.onTranscript || null;
    this.logger = logger;
    const {RtAudio} = require('xcraft-audify');
    this.rtAudio = new RtAudio();
    this.devices = this.rtAudio.getDevices();

    // --- État dynamic capture ---
    this.isRunning = false;
    this.inputSampleRate = 0;

    // --- État WS / session ---
    this.ws = null;
    this.wsClosed = false;
    this.clientSessionId = null;
    this.serverSessionId = null;

    this.remoteTranscripts = [];

    this.sessionMeta = {
      createdAt: new Date().toISOString(),
      startedAt: null,
      device: '',
      inputSampleRate: 0,
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

  /**
   * Connexion au WS + handshake "start" + attente de "ready"
   *
   * @param {string} sessionId
   * @param {Object} meta
   * @returns {Promise<void>}
   */
  async connectWebSocket(sessionId, meta = {}) {
    this.clientSessionId = sessionId;

    const url = new URL(this.wsUrl);
    url.searchParams.set('apiKey', this.apiKey);

    this.ws = new WebSocket(url.toString());
    this.wsClosed = false;

    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        if (!ready) {
          reject(new Error('Timeout connexion WebSocket'));
        }
      }, 10000);

      this.ws.on('open', () => {
        this.log('🔌 WS connecté, envoi du start');
        this.ws.send(
          JSON.stringify({
            type: 'start',
            clientSessionId: this.clientSessionId,
            language: this.language,
            meta,
          })
        );
      });

      this.ws.on('message', (data) => {
        // Le gateway n’envoie que du texte JSON
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          this.log(`<< WS raw: ${data}`);
          return;
        }

        switch (msg.type) {
          case 'ready':
            this.serverSessionId = msg.sessionId;
            ready = true;
            clearTimeout(timeout);
            this.log(
              `✅ WS ready (serverSessionId=${this.serverSessionId}, clientSessionId=${msg.clientSessionId})`
            );
            resolve();
            break;

          case 'transcript': {
            const evt = {
              text: msg.text || '',
              isFinal: !!msg.isFinal,
              timestamp: msg.timestamp || Date.now(),
              segmentIndex:
                typeof msg.segmentIndex === 'number'
                  ? msg.segmentIndex
                  : undefined,
              raw: msg,
            };

            this.remoteTranscripts.push(evt);

            if (this.onTranscript) {
              this.onTranscript(evt);
            } else {
              this.log(evt.text);
            }
            break;
          }

          case 'error':
            this.log(`❌ WS error: ${msg.message || 'unknown error'}`);
            break;

          case 'pong':
            // ping/pong optionnel
            break;

          default:
            this.log(`<< WS message: ${JSON.stringify(msg)}`);
        }
      });

      this.ws.on('close', () => {
        this.wsClosed = true;
        clearTimeout(timeout);
        this.log('🔌 WS fermé');
        if (!ready) {
          reject(new Error('WS fermé avant ready'));
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this.log(`❌ WS error: ${err.message}`);
        if (!ready) {
          reject(err);
        }
      });
    });
  }

  /**
   * Démarre la capture micro et l’envoi vers le serveur WS.
   *
   * @param {string} sessionId - ID logique côté client (retransmis au serveur).
   * @param {number} deviceIndex - Index du device RtAudio.
   */
  async start(sessionId, deviceIndex) {
    const device = this.devices[deviceIndex];
    if (!device || device.inputChannels === 0) {
      throw new Error('❌ Périphérique invalide.');
    }

    const inputSampleRate = device.preferredSampleRate || 48000;
    this.inputSampleRate = inputSampleRate;

    this.sessionMeta.device = device.name;
    this.sessionMeta.inputSampleRate = inputSampleRate;
    this.sessionMeta.startedAt = new Date().toISOString();

    // 1) WS handshake + "ready"
    await this.connectWebSocket(sessionId, {
      device: device.name,
      host: os.hostname(),
    });

    const frameSize = Math.floor((this.FRAME_SIZE * inputSampleRate) / 48000);
    const {RtAudioFormat} = require('xcraft-audify');
    // 2) Ouverture du stream audio → envoi direct des chunks resamplés à 16k
    this.rtAudio.openStream(
      null,
      {deviceId: device.id, nChannels: 1, firstChannel: 0},
      RtAudioFormat.RTAUDIO_FLOAT32,
      inputSampleRate,
      frameSize,
      'RemoteWhisperStream',
      async (pcmBuffer) => {
        if (!this.isRunning) {
          return;
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          return;
        }

        const samples = new Float32Array(
          pcmBuffer.buffer,
          pcmBuffer.byteOffset,
          pcmBuffer.byteLength / 4
        );

        // Resample chunk -> 16k, mono
        const resampled = resampleTo16kHz(
          samples,
          inputSampleRate,
          this.TARGET_SAMPLE_RATE
        );

        // Envoi direct d’un chunk 16kHz au serveur
        if (resampled.length > 0) {
          try {
            this.ws.send(Buffer.from(resampled.buffer));
          } catch (err) {
            this.log(`❌ Erreur envoi WS: ${err.message}`);
          }
        }
      }
    );

    this.rtAudio.start();
    this.isRunning = true;
    this.log('🚀 Capture remote Whisper démarrée.');
  }

  /**
   * Stoppe la capture et ferme proprement la session côté serveur.
   *
   * @returns {Promise<Object>} Résumé de session.
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    this.log('\n🛑 Fin de la capture remote');
    this.isRunning = false;

    try {
      this.rtAudio.stop();
    } catch (_) {}
    try {
      this.rtAudio.closeStream();
    } catch (_) {}

    // Envoi d’un "stop" au serveur pour flush final
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({type: 'stop'}));
      } catch (err) {
        this.log(`❌ Erreur envoi stop WS: ${err.message}`);
      }
    }

    // Attendre la fermeture WS (ou timeout)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 5000);

      if (!this.ws) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      if (this.wsClosed || this.ws.readyState === WebSocket.CLOSED) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      this.ws.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    return this.formatRemoteTranscript();
  }

  formatRemoteTranscript() {
    return {
      sessionId: this.clientSessionId,
      startedAt: this.sessionMeta.startedAt,
      transcripts: this.remoteTranscripts,
    };
  }
}

module.exports = WhisperRecorderRemote;
