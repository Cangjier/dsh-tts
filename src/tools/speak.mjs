/**
 * The `tts_speak` tool: one utterance, or a whole conversation.
 *
 * Two actions rather than one, because they differ in what the caller has to supply and in what
 * comes back: `speak` needs text and returns a file, `dialogue` needs a cast and returns a timeline.
 * Both resolve their engine through the same provider registry, so a voice that works in one works
 * in the other.
 *
 * @module dsh-tts/tools/speak
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

/** Every action of the speak tool, in dispatch order. */
export const SPEAK_ACTIONS = ['speak', 'dialogue']

/** The tool name, exported so a caller cannot misspell it. */
export const SPEAK_TOOL_NAME = 'tts_speak'

/**
 * Build the `tts_speak` tool.
 * @param {Record<string, Function>} actions - one handler per action.
 * @returns {object} the tool definition.
 */
export function createSpeakTool(actions) {
  return defineFamilyTool({
    name: SPEAK_TOOL_NAME,
    actions: SPEAK_ACTIONS,
    extraProperties: {
      text: {
        type: 'string',
        description: 'speak: the text to say. Give either text or textPath; text wins when both are present.',
      },
      textPath: {
        type: 'string',
        description:
          'speak: read the text from this UTF-8 file instead. A byte-order mark is stripped, because PowerShell writes one.',
      },
      script: {
        type: 'string',
        description:
          'dialogue: the conversation inline, one turn per line as "speaker: text". A line without a recognised prefix continues the previous turn.',
      },
      scriptPath: {
        type: 'string',
        description: 'dialogue: read the conversation from this UTF-8 file instead of passing it inline.',
      },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: { speaker: { type: 'string' }, text: { type: 'string' } },
          required: ['speaker', 'text'],
        },
        description:
          'dialogue: the turns as structured objects, which is what to use when the script is generated rather than written by hand. It takes precedence over script / scriptPath.',
      },
      speakers: {
        type: 'array',
        items: { type: 'string' },
        description:
          'dialogue: the only prefixes that count as speakers. Defaults to the keys of `voices`, which is what keeps an ordinary colon inside a sentence from inventing a speaker.',
      },
      voices: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'dialogue: speaker name to voice short name, for example {"host-a": "zh-CN-XiaoxiaoNeural"}. A speaker not listed here falls back to `voice`.',
      },
      voice: {
        type: 'string',
        description:
          'speak / dialogue: the voice short name. Defaults to config.edge.voice for provider "edge" (zh-CN-XiaoxiaoNeural), or config.command.voice for a local engine.',
      },
      rate: {
        type: 'string',
        description: 'speak: rate adjustment such as "+10%" or "-15%". Only engines that take one apply it.',
      },
      pitch: {
        type: 'string',
        description: 'speak: pitch adjustment such as "-2Hz". Provider "edge" only.',
      },
      volume: {
        type: 'string',
        description: 'speak: volume adjustment such as "+0%". Provider "edge" only.',
      },
      provider: {
        type: 'string',
        enum: ['edge', 'command'],
        description:
          'speak / dialogue: which engine answers, overriding config.provider for this call. "edge" is the network read-aloud service with word timings; "command" is the local engine from config.command, which usually has none.',
      },
      outDir: {
        type: 'string',
        description: 'speak / dialogue: directory for the output. Defaults to config.outDir, then <cwd>/tts.',
      },
      outPath: {
        type: 'string',
        description:
          'speak: the audio file to write, overriding outDir. The timing sidecar goes beside it as <name>.words.json, and the extension is forced to match the engine.',
      },
      name: {
        type: 'string',
        description: 'speak: the file stem inside outDir. Default "voiceover", which is the name the video plugin already looks for.',
      },
      gapSeconds: {
        type: 'number',
        description: 'dialogue: silence between two lines, measured from the end of the trimmed previous line. Default 0.35.',
      },
      tailPadSeconds: {
        type: 'number',
        description:
          'dialogue: how much of each line is kept past its last word. Default 0.12, which lets the final phoneme decay; the engine\'s own trailing silence is cut beyond it.',
      },
      tailSeconds: {
        type: 'number',
        description: 'dialogue: room left after the last line in the reported totalSeconds. Default 0.5.',
      },
      timeoutMs: {
        type: 'number',
        description: 'speak / dialogue: per-line timeout in milliseconds. Defaults to the provider\'s own (60000 for edge).',
      },
      measure: {
        type: 'boolean',
        description:
          'speak / dialogue: also ask ffprobe how long the written file is, which is the only way tailSilenceSeconds exists. Default true; false skips a process per file.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
