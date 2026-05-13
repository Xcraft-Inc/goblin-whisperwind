'use strict';

const path = require('node:path');
const xFs = require('xcraft-core-fs');

module.exports = [
  {
    type: 'input',
    name: 'targetSampleRate',
    message: 'whisper sample rate',
    default: 16000,
  },
  {
    type: 'input',
    name: 'frameSize',
    message: 'rtaudio frame size',
    default: 1920,
  },
  {
    type: 'input',
    name: 'segmentSec',
    message: 'segment seconds',
    default: 5,
  },
  {
    type: 'input',
    name: 'maxBufferSec',
    message: 'max buffer in seconds',
    default: 120,
  },
  {
    type: 'input',
    name: 'modelsSourceRepo',
    message: 'hugging face repo',
    default: 'https://huggingface.co/ggerganov/whisper.cpp',
  },
  {
    type: 'input',
    name: 'modelsSourcePrefix',
    message: '',
    default: 'resolve/main/ggml',
  },
  {
    type: 'input',
    name: 'remoteWindServerUrl',
    message: 'wind server ws url',
    default: 'wss://<host>/ws/transcribe',
  },
  {
    type: 'input',
    name: 'windServerHost',
    message: 'http ws host',
    default: '0.0.0.0',
  },
  {
    type: 'input',
    name: 'windServerPort',
    message: 'http ws port',
    default: 3000,
  },
  {
    type: 'list',
    name: 'audioModule',
    message: 'select the default audio module (audify, naudiodon)',
    choices: xFs
      .ls(path.join(__dirname, 'lib/audio'), /\.js$/)
      .map((mod) => mod.replace(/\.js$/, '')),
    default: 'audify',
  },
  {
    type: 'input',
    name: 'audioBackend',
    message:
      '(for audify only) leave empty for unspecified, or choose between: core, alsa, pulse, wasapi, ds',
    default: '',
  },
];
