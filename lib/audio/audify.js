const {RtAudio, RtAudioApi, RtAudioFormat} = require('xcraft-audify');

class Audify {
  #rtAudio;

  static get AudioFormat() {
    return RtAudioFormat;
  }

  constructor() {
    const {rtAudioBackend} = require('xcraft-core-etc')().load(
      'goblin-whisperwind'
    );

    let api = RtAudioApi.UNSPECIFIED;
    switch (rtAudioBackend) {
      case 'core':
        api = RtAudioApi.MACOSX_CORE;
        break;
      case 'alsa':
        api = RtAudioApi.LINUX_ALSA;
        break;
      case 'pulse':
        api = RtAudioApi.LINUX_PULSE;
        break;
      case 'wasapi':
        api = RtAudioApi.WINDOWS_WASAPI;
        break;
      case 'ds':
        api = RtAudioApi.WINDOWS_DS;
        break;
    }
    this.#rtAudio = new RtAudio(api);
  }

  getDevices() {
    return this.#rtAudio.getDevices();
  }

  start() {
    this.#rtAudio.start();
  }

  stop() {
    this.#rtAudio.stop();
  }

  openStream(
    input,
    output,
    format,
    sampling,
    frameSize,
    streamName,
    dataCalllback
  ) {
    this.#rtAudio.openStream(
      input,
      output,
      format,
      sampling,
      frameSize,
      streamName,
      dataCalllback
    );
  }

  closeStream() {
    this.#rtAudio.closeStream();
  }
}

module.exports = Audify;
