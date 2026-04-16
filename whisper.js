const {Elf} = require('xcraft-core-goblin');
const {Whisper, WhisperLogic} = require('goblin-whisperwind/lib/whisper.js');

exports.xcraftCommands = Elf.birth(Whisper, WhisperLogic);
