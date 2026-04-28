// @ts-check
const {Elf} = require('xcraft-core-goblin');
const {
  string,
  enumeration,
  number,
  array,
  option,
  boolean,
} = require('xcraft-core-stones');
const WhisperThread = require('./whisperThread.js');
const {buildRtAudio} = require('./utils.js');

function getModelLocation(model) {
  const path = require('node:path');
  const xConfig = require('xcraft-core-etc')().load('xcraft');
  return path.join(xConfig.xcraftRoot, 'var/whisperwind', `ggml-${model}.bin`);
}

async function isModelAvailable(model) {
  const fs = require('node:fs/promises');
  const location = getModelLocation(model);
  try {
    await fs.access(location, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const MODELS = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v3',
  'large-v3-turbo',
];

class WhisperShape {
  id = string;
  mode = enumeration('remote', 'local');
  defaultDeviceId = option(number);
  defaultLoopbackDeviceId = option(number);
  usableDevices = array;
  running = boolean;
}

class WhisperState extends Elf.Sculpt(WhisperShape) {}

class WhisperLogic extends Elf.Archetype {
  static db = 'whisperwind';

  state = new WhisperState({
    id: undefined,
    mode: 'remote',
    defaultDeviceId: null,
    defaultLoopbackDeviceId: null,
    usableDevices: [],
    running: false,
  });

  create(id) {
    this.state.id = id;
  }

  start() {
    this.state.running = true;
  }

  stop() {
    this.state.running = false;
  }

  setMode(mode) {
    this.state.mode = mode;
  }

  setDefaultDeviceId(deviceId) {
    this.state.defaultDeviceId = Number.parseInt(deviceId);
  }

  setDefaultLoopbackDeviceId(deviceId) {
    this.state.defaultLoopbackDeviceId = Number.parseInt(deviceId);
  }

  updateUsableDevices(devices) {
    this.state.usableDevices = devices;
  }
}

class Whisper extends Elf {
  logic = Elf.getLogic(WhisperLogic);
  state = new WhisperState();

  _whisperThread;
  _abortController;
  _logger;
  _server;

  async create(id, desktopId, server = false) {
    this._server = server;
    this.logic.create(id);
    await this.configure();
    await this.persist();
    return this;
  }

  async configure(enableTermuxLogger = false) {
    if (!this._whisperThread) {
      this._whisperThread = new WhisperThread(this._logger);
      if (this._server) {
        return; //leave useless configure
      }
    }
    const usableDevice = await this.updateUsableDevices();
    if (usableDevice.length > 0) {
      const deviceIds = usableDevice.map((d) => d.deviceIndex);
      if (this.state.defaultDeviceId === null) {
        await this.setDefaultDeviceId(usableDevice[0].deviceIndex);
      } else if (!deviceIds.includes(this.state.defaultDeviceId)) {
        await this.setDefaultDeviceId(usableDevice[0].deviceIndex);
      }
      if (this.state.defaultLoopbackDeviceId === null) {
        await this.setDefaultLoopbackDeviceId(usableDevice[0].deviceIndex);
      } else if (!deviceIds.includes(this.state.defaultLoopbackDeviceId)) {
        await this.setDefaultDeviceId(usableDevice[0].deviceIndex);
      }
    }
    if (enableTermuxLogger) {
      this._logger = async (msg) => {
        this.quest.evt('<termux-output>', msg);
      };
    }
  }

  async setMode(mode) {
    this.logic.setMode(mode);
    await this.persist();
  }

  async start(loopback = false, model, input) {
    if (!input) {
      const defaults = await this.getDefaultDevices();
      input = defaults.defaultDeviceId;
      if (loopback) {
        input = defaults.defaultLoopbackDeviceId;
      }
    }

    if (this.state.mode === 'local') {
      if (!model) {
        model = await this.getDefaultModel();
      }
      const available = await isModelAvailable(model);
      if (!available) {
        return 'model not installed';
      }
      const modelFilePath = getModelLocation(model);
      await this._whisperThread.init(modelFilePath, this.state.mode);
    } else {
      await this._whisperThread.init(null, this.state.mode);
    }

    this._abortController = new AbortController();
    try {
      this.log.dbg('Start recording on device :', input);
      await this._whisperThread.start(
        this.state.id,
        Number.parseInt(input),
        this._abortController
      );
      this.logic.start();
    } catch (err) {
      this.log.err(err);
      throw new Error(`${this.state.id}: ${err}`);
    }
  }

  async stop() {
    if (!this._whisperThread) {
      return null;
    }
    const {result} = await this._whisperThread.stop(this._abortController);
    this.logic.stop();
    return result;
  }

  async getDefaultModel() {
    const installed = await Promise.all(MODELS.map((m) => isModelAvailable(m)));
    const available = MODELS.map((m, i) => {
      return {model: m, installed: installed[i]};
    }).filter((a) => !!a.installed);
    if (available.length) {
      return available[available.length - 1].model;
    }
    return null;
  }

  async getAudioDevices() {
    this.rtAudio = buildRtAudio();
    const devices = this.rtAudio.getDevices();
    return devices;
  }

  async getDefaultDevices() {
    await this.configure();
    return {
      defaultDeviceId: this.state.defaultDeviceId,
      defaultLoopbackDeviceId: this.state.defaultLoopbackDeviceId,
    };
  }

  async updateUsableDevices() {
    this.rtAudio = buildRtAudio();
    const devices = this.rtAudio.getDevices();

    const usable = devices
      .map((d, i) => {
        if (d.inputChannels > 0) {
          return {deviceIndex: i, name: d.name};
        } else {
          return null;
        }
      })
      .filter((d) => !!d);

    this.logic.updateUsableDevices(usable);
    await this.persist();
    return usable;
  }

  async setDefaultDeviceId(deviceId) {
    this.logic.setDefaultDeviceId(deviceId);
    await this.persist();
  }

  async setDefaultLoopbackDeviceId(deviceId) {
    this.logic.setDefaultLoopbackDeviceId(deviceId);
    await this.persist();
  }

  async installModel(model) {
    await this.configure();
    if (!MODELS.includes(model)) {
      return `unknow model ${model}`;
    }
    const available = await isModelAvailable(model);
    if (available) {
      return 'model already installed';
    }
    const modelFilePath = getModelLocation(model);
    this._abortController = new AbortController();
    let installed;
    try {
      installed = await this._whisperThread.installModel(
        model,
        modelFilePath,
        this._abortController
      );
    } catch (err) {
      this.log.err(err);
    }
    if (!installed) {
      return 'Error during model installation';
    }
    return 'model installed !';
  }

  dispose() {
    this._whisperThread = null;
  }

  async delete() {}
}

module.exports = {
  Whisper,
  WhisperLogic,
  isModelAvailable,
  getModelLocation,
  MODELS,
};
