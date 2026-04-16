// @ts-check
const {Elf} = require('xcraft-core-goblin');
const {string} = require('xcraft-core-stones');
const path = require('node:path');
const {Worker} = require('worker_threads');
const registerTranscriptionWs = require('./server/gateway.js');
const TranscriptionScheduler = require('./server/scheduler.js');

class WindShape {
  id = string;
}

class WindState extends Elf.Sculpt(WindShape) {}

class WindLogic extends Elf.Spirit {
  state = new WindState({
    id: 'wind',
  });
}

class Wind extends Elf.Alone {
  logic = Elf.getLogic(WindLogic);
  state = new WindState();
  started = false;
  modelPath;

  async boot() {
    this.log.dbg('Booting...');
    const {Whisper, getModelLocation} = require('./whisper.js');
    const whisper = await new Whisper(this).create(
      'whisper@server',
      'system@wind',
      true
    );
    let model = await whisper.getDefaultModel();
    if (!model) {
      model = 'large-v3-turbo';
      await whisper.installModel(model);
    }
    this.modelPath = getModelLocation(model);
  }

  async start() {
    if (this.started) {
      return;
    }

    const logInfo = (infos) => {
      this.log.dbg(infos);
    };
    const logError = (err) => {
      this.log.err(err);
    };

    const whisperWorker = new Worker(path.join(__dirname, 'server/worker.js'), {
      workerData: {
        modelPath: this.modelPath,
      },
    });

    const scheduler = new TranscriptionScheduler(whisperWorker, logInfo);

    const validateApiKey = (apiKey) => {
      return apiKey === 'wind-key';
    };

    const onSessionStarted = ({session, sendTranscript}) => {
      scheduler.startSession(
        session.id,
        session.clientSessionId,
        session.config.language,
        sendTranscript
      );
    };

    const onAudioBuffer = ({session, float32, isLast}) => {
      scheduler.pushAudio(session.id, float32, isLast);
    };

    const onSessionEnded = ({session, reason}) => {
      scheduler.endSession(session.id);
      this.log.dbg(`Session ended (WS/onSessionEnded) ${session.id} ${reason}`);
    };

    const {windServerHost, windServerPort} = require('xcraft-core-etc')().load(
      'goblin-whisperwind'
    );

    registerTranscriptionWs({
      host: windServerHost,
      port: windServerPort,
      validateApiKey,
      onSessionStarted,
      onAudioBuffer,
      onSessionEnded,
      logInfo,
      logError,
    });

    this.started = false;
  }
}

module.exports = {Wind, WindLogic};
