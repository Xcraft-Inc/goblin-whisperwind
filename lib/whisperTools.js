// @ts-check
const {Elf} = require('xcraft-core-goblin');
const {string} = require('xcraft-core-stones');
const {
  getModelLocation,
  isModelAvailable,
  MODELS,
  Whisper,
} = require('./whisper.js');

const INSTRUCTION_REGEX = /\bbob\b[\s,;:!?.-]*(.+)$/i;

function detectVoiceInstruction(text) {
  const match = text.match(INSTRUCTION_REGEX);
  if (!match) return null;

  let instruction = match[1].trim();
  instruction = instruction.replace(/[.!?]+$/g, '').trim();
  return instruction || null;
}

class WhisperToolsShape {
  id = string;
}

class WhisperToolsState extends Elf.Sculpt(WhisperToolsShape) {}

class WhisperToolsLogic extends Elf.Spirit {
  static db = 'whisperwind';

  state = new WhisperToolsState({
    id: 'whisperTools',
  });
}

class WhisperTools extends Elf.Alone {
  logic = Elf.getLogic(WhisperToolsLogic);
  state = new WhisperToolsState();
  _logger;

  async assist(userDesktopId, instruct) {
    //TODO: configurable by event
    //Temp dep for PoC only
    const workflowId = 'workflow@yeti-voice-assistant';
    const {Compendium} = require('goblin-chronicle/lib/compendium.js');
    const compendium = new Compendium(this);
    await compendium.beginChronicle(
      userDesktopId,
      workflowId,
      {contextId: workflowId, createdBy: `user@yeti`},
      {instruct}
    );
  }

  async setDefaultDevice(input) {
    const userDesktopId = await this.winDesktopId();
    const whisper = await new Whisper(this).create(
      'whisper@main',
      userDesktopId
    );
    await whisper.setDefaultDeviceId(input);
    return 'entrée séléctionnée';
  }

  async stop() {
    const userDesktopId = await this.winDesktopId();
    const whisper = await new Whisper(this).create(
      'whisper@main',
      userDesktopId
    );
    const result = await whisper.stop();
    return JSON.stringify(result, null, 2);
  }

  async whisper$tool(verb, model) {
    const userDesktopId = await this.winDesktopId();
    const whisper = await new Whisper(this).create(
      'whisper@main',
      userDesktopId
    );
    await whisper.configure(true);
    switch (verb) {
      default:
        return '';
      case 'local':
        await whisper.setMode('local');
        return 'local transcription mode set ✅';
      case 'remote':
        await whisper.setMode('remote');
        return 'remote transcription mode set ✅';
      case 'list': {
        const installed = await Promise.all(
          MODELS.map((m) => isModelAvailable(m))
        );
        return MODELS.map((m, i) => `${m}: ${installed[i] ? '✅' : '⬇️'}`).join(
          '\n'
        );
      }

      case 'install': {
        return await whisper.installModel(model);
      }
      case 'input': {
        const usableDevices = await whisper.updateUsableDevices();
        this.quest.evt('<termux-input>', {
          question: `Selected recording device number :\n${usableDevices
            .map((d) => `${d.name} [${d.deviceIndex}]`)
            .join('\n')}`,
          cmd: 'whisperTools.setDefaultDevice',
          args: {},
        });
        return;
      }

      case 'start':
        {
          await whisper.start(null, model);
          this.quest.evt('<termux-input>', {
            question: `Press ENTER to stop recording`,
            cmd: 'whisperTools.stop',
            args: {},
          });
        }
        break;
    }
  }

  async $tool(tool) {
    if (tool !== 'whisper') {
      return {};
    }
    return {
      install: null, //TODO FIXME: Object.fromEntries(MODELS.map((name) => [name, null])),
      start: null,
      list: null,
      local: null,
      remote: null,
      input: null,
    };
  }
}

module.exports = {WhisperTools, WhisperToolsLogic};
