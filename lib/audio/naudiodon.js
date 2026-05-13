const portAudio = require('xcraft-naudiodon');

class Naudiodon {
  #audioIO;

  constructor() {}

  get SampleFormat() {
    return {
      SINT8: portAudio.SampleFormat8Bit,
      SINT16: portAudio.SampleFormat16Bit,
      SINT24: portAudio.SampleFormat24Bit,
      SINT32: portAudio.SampleFormat32Bit,
      FLOAT32: portAudio.SampleFormatFloat32,
    };
  }

  getDevices() {
    return portAudio.getDevices().map((device) => ({
      id: device.id,
      name: device.name,
      inputChannels: device.maxInputChannels,
      outputChannels: device.maxOutputChannels,
      sampleRate: device.defaultSampleRate,
      isDefaultInput: device.name === 'default',
      isDefaultOutput: device.name === 'default',
    }));
  }

  start() {
    this.#audioIO.start();
  }

  stop() {
    this.#audioIO.abort();
  }

  openInputStream(
    deviceId,
    channels,
    sampleFormat,
    sampleRate,
    frameSize,
    dataCalllback
  ) {
    this.#audioIO = new portAudio.AudioIO({
      inOptions: {
        deviceId,
        channelCount: channels,
        sampleRate,
        sampleFormat,
        framesPerBuffer: frameSize,
      },
    });
    this.#audioIO.on('data', dataCalllback);
  }
}

module.exports = Naudiodon;
