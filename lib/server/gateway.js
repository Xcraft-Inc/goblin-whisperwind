// @ts-check
const http = require('http');
const {WebSocketServer} = require('ws');
const {randomUUID} = require('node:crypto');

/**
 * @typedef {Object} TranscriptionConfig
 * @property {string} language
 */

/**
 * @typedef {Object} TranscriptionSession
 * @property {string} id
 * @property {string|null} clientSessionId
 * @property {string} apiKey
 * @property {number} createdAt
 * @property {TranscriptionConfig|null} config
 * @property {number} frameIndex
 * @property {boolean} closed
 * @property {boolean} stopRequested
 */

/**
 * @typedef {Object} SendTranscriptParams
 * @property {string} text
 * @property {boolean} [isFinal=false]
 * @property {number} [timestamp]
 * @property {Record<string, any>} [extra]
 */

/**
 * @callback SendTranscript
 * @param {SendTranscriptParams} params
 * @returns {Promise<void>}
 */

/**
 * @callback ValidateApiKey
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */

/**
 * @callback OnSessionStarted
 * @param {Object} args
 * @param {TranscriptionSession} args.session
 * @param {SendTranscript} args.sendTranscript
 * @returns {Promise<void>}
 */

/**
 * @callback OnAudioBuffer
 * @param {Object} args
 * @param {TranscriptionSession} args.session
 * @param {Buffer} args.buffer
 * @param {Float32Array} args.float32
 * @param {number} args.frameIndex
 * @param {boolean} args.isLast
 * @param {SendTranscript} args.sendTranscript
 * @returns {Promise<void>}
 */

/**
 * @callback OnSessionEnded
 * @param {Object} args
 * @param {TranscriptionSession} args.session
 * @param {string} args.reason
 * @returns {Promise<void>}
 */

/**
 * @typedef {Object} RegisterTranscriptionWsOptions
 * @property {number} port
 * @property {string} [host]
 * @property {ValidateApiKey} validateApiKey
 * @property {OnSessionStarted} [onSessionStarted]
 * @property {OnAudioBuffer} onAudioBuffer
 * @property {OnSessionEnded} [onSessionEnded]
 * @property {(msg: string, extra?: any) => void} [logInfo]
 * @property {(msg: string, extra?: any) => void} [logError]
 */

/**
 * Démarre un serveur HTTP + WebSocket dédié à la transcription temps réel.
 *
 * - URL: ws://host:port/ws/transcribe?apiKey=XXX
 * - 1 WebSocket = 1 session
 * - Messages texte:
 *    { "type": "start", "clientSessionId": "...", "language": "fr", "meta": {...} }
 *    { "type": "stop" }
 *    { "type": "ping" }
 * - Messages binaires:
 *    Float32Array.buffer (mono, 16kHz)
 *
 * @param {RegisterTranscriptionWsOptions} options
 * @returns {{ server: http.Server, wss: WebSocketServer }}
 */
function registerTranscriptionWs(options) {
  const {
    port,
    host = 'localhost',
    validateApiKey,
    onSessionStarted,
    onAudioBuffer,
    onSessionEnded,
    logInfo = (msg, extra) => console.log('[INFO]', msg, extra || ''),
    logError = (msg, extra) => console.error('[ERROR]', msg, extra || ''),
  } = options;

  if (typeof validateApiKey !== 'function') {
    throw new Error('validateApiKey option is required');
  }
  if (typeof onAudioBuffer !== 'function') {
    throw new Error('onAudioBuffer option is required');
  }

  // HTTP minimal (404 sur tout sauf upgrade WS)
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });

  // WebSocketServer dédié au endpoint /ws/transcribe
  const wss = new WebSocketServer({
    server,
    path: '/ws/transcribe',
  });

  wss.on('connection', (ws, req) => {
    // On encapsule tout dans un IIFE async pour pouvoir await validateApiKey etc.
    (async () => {
      // --- Extraction API key (query + headers) ---
      let apiKey;
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        apiKey =
          url.searchParams.get('apiKey') ||
          req.headers['x-api-key'] ||
          (typeof req.headers['authorization'] === 'string'
            ? req.headers['authorization'].replace(/^Bearer\s+/i, '')
            : undefined);
      } catch {
        apiKey = undefined;
      }

      if (!apiKey) {
        safeSendRaw(ws, {type: 'error', message: 'Missing API key'});
        ws.close();
        return;
      }

      let allowed = false;
      try {
        allowed = await validateApiKey(String(apiKey));
      } catch (err) {
        logError('API key validation failed', {err});
      }

      if (!allowed) {
        safeSendRaw(ws, {type: 'error', message: 'Invalid API key'});
        ws.close();
        return;
      }

      /** @type {TranscriptionSession} */
      const session = {
        id: randomUUID(),
        clientSessionId: null,
        apiKey: String(apiKey),
        createdAt: Date.now(),
        config: null,
        frameIndex: 0,
        closed: false,
        stopRequested: false,
      };

      logInfo('Transcription session opened', {sessionId: session.id});

      /**
       * Envoie un message JSON sûr au client, en injectant sessionId/clientSessionId.
       * @param {Record<string, any>} payload
       */
      const safeSend = (payload) => {
        if (session.closed) return;
        safeSendRaw(ws, {
          sessionId: session.id,
          clientSessionId: session.clientSessionId,
          ...payload,
        });
      };

      /**
       * Termine proprement la session & ferme le WebSocket.
       * @param {string} [reason='normal']
       */
      const finalizeSession = async (reason = 'normal') => {
        if (session.closed) return;
        session.closed = true;

        try {
          if (typeof onSessionEnded === 'function') {
            await onSessionEnded({session, reason});
          }
        } catch (err) {
          logError('onSessionEnded failed', {err, sessionId: session.id});
        }

        try {
          ws.close();
        } catch {
          // ignore
        }

        logInfo('Transcription session closed', {
          sessionId: session.id,
          reason,
        });
      };

      /** @type {SendTranscript} */
      const sendTranscript = async ({
        text,
        isFinal = false,
        timestamp = Date.now(),
        extra = {},
      }) => {
        if (!text) {
          return;
        }
        safeSend({
          type: 'transcript',
          text,
          isFinal,
          timestamp,
          ...extra,
        });

        if (isFinal) {
          await finalizeSession('completed');
        }
      };

      /**
       * Initialise la config de session à partir du message "start".
       * Le client ne peut configurer que la langue + meta.
       * @param {any} msg
       */
      const setupConfigFromStart = (msg) => {
        session.clientSessionId = msg.clientSessionId || null;
        session.config = {
          language: msg.language || 'fr',
        };
      };

      /**
       * Traite un message binaire audio.
       * @param {Buffer|Uint8Array|ArrayBuffer} raw
       */
      const processAudioMessage = async (raw) => {
        if (!session.config) {
          safeSend({
            type: 'error',
            message: 'You must send a "start" message before audio data.',
          });
          return;
        }
        if (session.stopRequested) {
          return;
        }

        // Normalise en Buffer Node
        let buffer;
        if (Buffer.isBuffer(raw)) {
          buffer = raw;
        } else if (raw instanceof ArrayBuffer) {
          buffer = Buffer.from(raw);
        } else {
          buffer = Buffer.from(raw);
        }

        // On s'assure d'avoir un ArrayBuffer aligné sur 4 octets
        // en recoupant exactement la fenêtre utile.
        const byteLength = buffer.byteLength - (buffer.byteLength % 4);
        if (byteLength === 0) {
          // Rien à lire (bizarre, mais on ne plante pas)
          return;
        }

        const aligned = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + byteLength
        );

        const float32 = new Float32Array(aligned);

        const frameIndex = session.frameIndex++;
        const isLast = false; // le "vrai" last est géré via le message "stop"

        try {
          await onAudioBuffer({
            session,
            buffer,
            float32,
            frameIndex,
            isLast,
            sendTranscript,
          });
        } catch (err) {
          logError('onAudioBuffer failed', {err, sessionId: session.id});
          safeSend({
            type: 'error',
            message: 'Transcription backend error',
          });
        }
      };

      ws.on('message', async (data, isBinary) => {
        if (!isBinary) {
          // Messages texte de contrôle : start/stop/ping
          let msg;
          try {
            msg = JSON.parse(data.toString('utf8'));
          } catch {
            safeSend({type: 'error', message: 'Invalid JSON message'});
            return;
          }

          switch (msg.type) {
            case 'start':
              try {
                setupConfigFromStart(msg);

                if (typeof onSessionStarted === 'function') {
                  await onSessionStarted({session, sendTranscript});
                }

                safeSend({
                  type: 'ready',
                  config: session.config,
                });
              } catch (err) {
                logError('"start" handling failed', {
                  err,
                  sessionId: session.id,
                });
                safeSend({
                  type: 'error',
                  message: err.message || 'Failed to start transcription',
                });
                await finalizeSession('start_failed');
              }
              return;

            case 'stop':
              session.stopRequested = true;
              try {
                await onAudioBuffer({
                  session,
                  buffer: Buffer.alloc(0),
                  float32: new Float32Array(0),
                  frameIndex: session.frameIndex,
                  isLast: true,
                  sendTranscript,
                });
              } catch (err) {
                logError('final onAudioBuffer (flush) failed', {
                  err,
                  sessionId: session.id,
                });
                safeSend({
                  type: 'error',
                  message: 'Transcription backend error on final flush',
                });
              }
              return;

            case 'ping':
              safeSend({type: 'pong', timestamp: Date.now()});
              return;

            default:
              safeSend({
                type: 'error',
                message: `Unknown message type: ${msg.type}`,
              });
              return;
          }
        }

        // Binaire => un buffer Float32 complet
        await processAudioMessage(data);
      });

      ws.on('close', () => {
        void finalizeSession('ws_close');
      });

      ws.on('error', (err) => {
        logError('WebSocket error', {err, sessionId: session.id});
        void finalizeSession('ws_error');
      });
    })().catch((err) => {
      logError('Fatal WS connection handler error', {err});
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  });

  server.listen(port, host, () => {
    logInfo(`Wind Transcription WS server listening ${host}:${port}`);
  });

  return {server, wss};
}

/**
 * Envoie un JSON sur un WebSocket si possible.
 * @param {import('ws')} ws
 * @param {Record<string, any>} payload
 */
function safeSendRaw(ws, payload) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch {
    // ignore
  }
}

module.exports = registerTranscriptionWs;
