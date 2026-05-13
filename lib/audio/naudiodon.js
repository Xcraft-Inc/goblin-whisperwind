const portAudio = require('xcraft-naudiodon');

class Naudiodon {
  static get AudioFormat() {
    return {
      SINT8: portAudio.SampleFormat8Bit,
      SINT16: portAudio.SampleFormat16Bit,
      SINT24: portAudio.SampleFormat24Bit,
      SINT32: portAudio.SampleFormat32Bit,
      FLOAT32: portAudio.SampleFormatFloat32,
    };
  }

  constructor() {
    const {audioBackend} = require('xcraft-core-etc')().load(
      'goblin-whisperwind'
    );
  }

  getDevices() {
    return portAudio.getDevices().map((device) => ({
      id: device.id,
      name: device.name,
      inputChannels: device.maxInputChannels,
      sampleRate: device.defaultSampleRate,
    }));
  }

  start() {}

  stop() {}

  openStream(
    input,
    output,
    format,
    sampling,
    frameSize,
    streamName,
    dataCalllback
  ) {}

  closeStream() {}
}

module.exports = Naudiodon;
