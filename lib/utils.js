// @ts-check

const Audify = require('./audio/audify.js');
const Naudiodon = require('./audio/naudiodon.js');
const Pipewire = require('./audio/pipewire.js');

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

function createAudio() {
  const {audioModule} = require('xcraft-core-etc')().load('goblin-whisperwind');
  switch (audioModule) {
    case 'audify':
      return new Audify();
    case 'naudiodon':
      return new Naudiodon();
    case 'pipewire':
      return new Pipewire();
    default:
      throw new Error(`Unknown audio module: ${audioModule}`);
  }
}

module.exports = {calcRMS, resampleTo16kHz, createAudio};
