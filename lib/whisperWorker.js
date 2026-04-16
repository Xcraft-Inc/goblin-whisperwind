const {parentPort} = require('worker_threads');

let recorder = null;
let recorderActive = false;
let waitStopResolve = null;

const logger = (msg) => {
  parentPort?.postMessage({type: 'log', msg});
};

// Promise qui ne se résout qu’à l’arrêt
function waitUntilStop() {
  return new Promise((resolve) => {
    waitStopResolve = resolve;
  });
}

// --- Gestion des messages ---
parentPort.on('message', async (event) => {
  const {id, command, args = {}, options = {}, reason} = event;

  try {
    switch (command) {
      case 'install': {
        const fs = require('node:fs');
        const {unlink} = require('node:fs/promises');
        const {Readable} = require('node:stream');
        const {finished} = require('node:stream/promises');

        const outputFile = args.modelFilePath;
        const file = fs.createWriteStream(outputFile);
        const url = `${args.modelsSourceRepo}/${args.modelsSourcePrefix}-${args.model}.bin`;

        logger(`⬇️ Downloading ${url}...`);

        try {
          const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
          });
          if (response.status !== 200) {
            await unlink(outputFile);
            throw new Error(`HTTP ${response.status}`);
          }
          await finished(Readable.fromWeb(response.body).pipe(file));
          logger(`✅ Model '${args.model}' saved at '${args.modelFilePath}'`);
          parentPort.postMessage({id, type: 'done', ok: true});
        } catch (err) {
          try {
            await unlink(outputFile);
          } catch {}
          logger(`❌ Failed to download model: ${err.message}`);
          parentPort.postMessage({id, type: 'error', error: err.message});
        }
        break;
      }

      case 'init':
        {
          const WhisperRecorderRemote = require('./whisperRecorderRemote.js');
          recorder = new WhisperRecorderRemote({...options}, logger);

          if (options.mode && options.mode === 'local') {
            const WhisperRecorder = require('./whisperRecorder.js');
            recorder = new WhisperRecorder({...options}, logger);
          }

          parentPort.postMessage({
            id,
            type: 'done',
            devices: recorder.getDevices(),
          });
        }
        break;

      case 'start':
        if (recorderActive) {
          parentPort.postMessage({
            id,
            type: 'error',
            error: 'Recorder already running',
          });
          break;
        }

        recorderActive = true;
        await recorder.start(args.sessionId, args.deviceIndex);
        logger('🎧 WhisperRecorder started');

        parentPort.postMessage({id, type: 'started'});

        // Attend le signal stop
        await waitUntilStop();
        break;

      case 'stop':
        if (recorder && recorderActive) {
          const result = await recorder.stop();
          recorderActive = false;
          if (waitStopResolve) {
            await waitStopResolve();
          }
          parentPort.postMessage({id, type: 'done', result});
        } else {
          parentPort.postMessage({id, type: 'done', result: null});
        }
        break;

      case 'abort':
        logger(`🛑 Abort demandé (${reason || 'signal/timeout'})`);
        if (recorder && recorderActive) {
          try {
            await recorder.stop();
          } catch (err) {
            logger(`⚠️ Erreur pendant abort: ${err.message}`);
          }
          recorderActive = false;
          if (waitStopResolve) {
            waitStopResolve();
          }
        }
        parentPort.postMessage({id, type: 'done', aborted: true});
        break;

      default:
        parentPort.postMessage({
          id,
          type: 'error',
          error: `Unknown command: ${command}`,
        });
    }
  } catch (err) {
    recorderActive = false;
    parentPort.postMessage({id, type: 'error', error: err.message});
  }
});
