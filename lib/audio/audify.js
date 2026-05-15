const {RtAudio, RtAudioApi, RtAudioFormat} = require('xcraft-audify');

class Audify {
  #rtAudio;

  constructor() {
    const {audioBackend} = require('xcraft-core-etc')().load(
      'goblin-whisperwind'
    );

    let api = RtAudioApi.UNSPECIFIED;
    switch (audioBackend) {
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

  get SampleFormat() {
    return {
      SINT8: RtAudioFormat.RTAUDIO_SINT8,
      SINT16: RtAudioFormat.RTAUDIO_SINT16,
      SINT24: RtAudioFormat.RTAUDIO_SINT24,
      SINT32: RtAudioFormat.RTAUDIO_SINT32,
      FLOAT32: RtAudioFormat.RTAUDIO_FLOAT32,
    };
  }

  getDevices() {
    return this.#rtAudio.getDevices().map((device) => ({
      id: device.id,
      deviceIndex: device.deviceIndex,
      name: device.name,
      inputChannels: device.inputChannels,
      outputChannels: device.outputChannels,
      sampleRate: device.preferredSampleRate,
      isDefaultInput: device.isDefaultInput,
      isDefaultOutput: device.isDefaultOutput,
    }));
  }

  start() {
    this.#rtAudio.start();
  }

  stop() {
    this.#rtAudio.stop();
    this.#rtAudio.closeStream();
  }

  openInputStream(
    deviceId,
    channels,
    sampleFormat,
    sampleRate,
    frameSize,
    dataCalllback
  ) {
    this.#rtAudio.openStream(
      null,
      {deviceId, nChannels: channels, firstChannel: 1},
      sampleFormat,
      sampleRate,
      frameSize,
      'Stream',
      dataCalllback
    );
  }
}

module.exports = Audify;
