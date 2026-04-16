const {Elf} = require('xcraft-core-goblin');
const {
  WhisperTools,
  WhisperToolsLogic,
} = require('goblin-whisperwind/lib/whisperTools.js');

exports.xcraftCommands = Elf.birth(WhisperTools, WhisperToolsLogic);
