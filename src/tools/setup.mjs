/**
 * The `tts_setup` tool: what this machine can do, before anything is written.
 *
 * Kept apart from `tts_speak` because the costs differ by orders of magnitude: `status` reads
 * config and stats paths, `voices` makes one request, `check` really synthesizes. A caller that
 * only wants to know whether a voice name exists should not have to produce audio to find out.
 *
 * There is deliberately no `install`: the engines this plugin reaches are either a network endpoint
 * or something the caller already installed, and a plugin that silently downloads a model is a
 * plugin whose failures cannot be explained.
 *
 * @module dsh-tts/tools/setup
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

/** Every action of the setup tool, in dispatch order. */
export const SETUP_ACTIONS = ['status', 'voices', 'check']

/** The tool name, exported so a caller cannot misspell it. */
export const SETUP_TOOL_NAME = 'tts_setup'

/**
 * Build the `tts_setup` tool.
 * @param {Record<string, Function>} actions - one handler per action.
 * @returns {object} the tool definition.
 */
export function createSetupTool(actions) {
  return defineFamilyTool({
    name: SETUP_TOOL_NAME,
    actions: SETUP_ACTIONS,
    extraProperties: {
      provider: {
        type: 'string',
        enum: ['edge', 'command'],
        description: 'status / voices / check: which engine to report on. Defaults to the resolved provider.',
      },
      locale: {
        type: 'string',
        description: 'voices: keep only voices whose locale starts with this, case-insensitively — "zh" also returns zh-HK and zh-TW.',
      },
      limit: {
        type: 'number',
        description: 'voices: at most this many voices in the result. Default 100; total and count say what was cut.',
      },
      text: {
        type: 'string',
        description: 'check: the phrase to synthesize. Defaults to a short self-check sentence; keep it short, this is a liveness probe.',
      },
      voice: {
        type: 'string',
        description: 'check: the voice to use; defaults to the resolved provider default.',
      },
      rate: {
        type: 'string',
        description: 'check: rate adjustment, such as "-10%".',
      },
      pitch: {
        type: 'string',
        description: 'check: pitch adjustment, such as "-2Hz". Provider "edge" only.',
      },
      volume: {
        type: 'string',
        description: 'check: volume adjustment, such as "+0%". Provider "edge" only.',
      },
      timeoutMs: {
        type: 'number',
        description: 'check: give up after this long. Defaults to the provider\'s own.',
      },
      outDir: {
        type: 'string',
        description: 'check: where the probe file goes. Defaults to config.outDir, then <cwd>/tts.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
