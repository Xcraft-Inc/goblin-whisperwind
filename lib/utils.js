// @ts-check
function resampleTo16kHz(input, inputRate, targetInputRate) {
  if (inputRate === targetInputRate) {
    return input;
  }
  const ratio = inputRate / targetInputRate;
  const newLength = Math.round(input.length / ratio);
  const output = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const index0 = Math.floor(srcIndex);
    const index1 = Math.min(index0 + 1, input.length - 1);
    const frac = srcIndex - index0;
    output[i] = input[index0] * (1 - frac) + input[index1] * frac;
  }
  return output;
}

function calcRMS(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function buildRtAudio() {
  const {rtAudioBackend} = require('xcraft-core-etc')().load(
    'goblin-whisperwind'
  );
  const {RtAudio, RtAudioApi} = require('xcraft-audify');
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
  return new RtAudio(api);
}

module.exports = {calcRMS, resampleTo16kHz, buildRtAudio};
