/**
 * The `dsh-tts` Host plugin: text to speech, with the engine kept outside the plugin.
 *
 * The plugin is a plain ESM module with no harness import, so a profile can install it without a
 * build step and without a dependency edge on the harness packages it composes with. It validates
 * its own config, because validating through the Loader would require the dependency this module
 * exists to avoid.
 *
 * Division of labour, which the rest of the code depends on:
 *   DSH decides what should be said and in whose voice, which take is usable, and what the script
 *   is. This plugin only synthesizes: the same text, voice and parameters produce the same request,
 *   and it reports what came back — audio, word timings, duration, and which engine answered.
 *
 * Two providers, and the difference between them is a fact the caller has to know:
 *   `edge`    reaches Microsoft's read-aloud service. No key, good Mandarin, and it returns a
 *             boundary for every spoken word, which is where the timings come from.
 *   `command` runs whatever local TTS command line is configured. No timings, unless the engine
 *             prints them — so it reports `timings: "none"` instead of inventing them.
 *
 * @module dsh-tts
 */
import { registerTools } from './src/tools/index.mjs'
import { PROVIDER_IDS } from './src/core/providers/index.mjs'
import { DEFAULT_VOICE } from './src/core/providers/edge.mjs'

/** Stable Cordis plugin name. */
export const name = 'dsh-tts'

/** Services required before tools can be registered. */
export const inject = ['tools']

/** Environment variables this plugin reads, so a machine can be configured without a patch. */
export const ENV_KEYS = {
  provider: 'DSH_TTS_PROVIDER',
  voice: 'DSH_TTS_VOICE',
  outDir: 'DSH_TTS_OUT_DIR',
  ffprobe: 'DSH_TTS_FFPROBE',
  command: 'DSH_TTS_COMMAND',
}

/**
 * Read an optional string field, allowing null to mean "use the default".
 * @param {object} raw - the object to read from.
 * @param {string} key - the field name.
 * @param {string|null} fallback - the value to use when absent or null.
 * @param {string} where - the field's dotted path, for the error message.
 * @returns {string|null} the value.
 * @throws {TypeError} when the value is present and not a string.
 */
function optionalString(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new TypeError(`dsh-tts: ${where} must be a string or null`)
  return value
}

/**
 * Read an optional positive number field.
 * @param {object} raw - the object to read from.
 * @param {string} key - the field name.
 * @param {number} fallback - the value to use when absent or null.
 * @param {string} where - the field's dotted path, for the error message.
 * @returns {number} the value.
 * @throws {TypeError} when the value is present and not a positive finite number.
 */
function optionalPositiveNumber(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`dsh-tts: ${where} must be a positive number`)
  }
  return value
}

/**
 * Read an optional array of non-empty strings.
 * @param {object} raw - the object to read from.
 * @param {string} key - the field name.
 * @param {string[]} fallback - the value to use when absent or null.
 * @param {string} where - the field's dotted path, for the error message.
 * @returns {string[]} the value.
 * @throws {TypeError} when the value is present and not an array of strings.
 */
function optionalStringArray(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`dsh-tts: ${where} must be an array of strings or null`)
  }
  return [...value]
}

/**
 * Read an optional value that must be one of a fixed set.
 * @param {object} raw - the object to read from.
 * @param {string} key - the field name.
 * @param {string[]} allowed - the legal values.
 * @param {string} fallback - the value to use when absent or null.
 * @param {string} where - the field's dotted path, for the error message.
 * @returns {string} the value.
 * @throws {TypeError} when the value is present and not one of `allowed`.
 */
function optionalEnum(raw, key, allowed, fallback, where) {
  const value = optionalString(raw, key, null, where)
  if (value === null) return fallback
  if (!allowed.includes(value)) {
    throw new TypeError(`dsh-tts: ${where} must be one of ${allowed.join(', ')}`)
  }
  return value
}

/**
 * Validate and normalize one `command` provider config.
 *
 * `path` is the only required field: everything else has a default that works for the common
 * shape (text on stdin, output file named by the plugin). The placeholders a template may use are
 * `{out}`, `{text}`, `{textFile}`, `{voice}` — anything else is left untouched, because an engine
 * may legitimately want a literal brace argument.
 *
 * @param {object} raw - the `config.command` object.
 * @returns {object} the normalized command provider config.
 * @throws {TypeError} when `path` is missing or a field has the wrong type.
 */
function normalizeCommand(raw) {
  const path = optionalString(raw, 'path', null, 'config.command.path')
  if (path === null || path.trim() === '') {
    throw new TypeError('dsh-tts: config.command.path is required when config.command is set')
  }
  const voices = raw.voices === undefined || raw.voices === null ? [] : raw.voices
  if (!Array.isArray(voices) || voices.some((item) => typeof item !== 'string')) {
    throw new TypeError('dsh-tts: config.command.voices must be an array of strings or null')
  }
  return {
    path,
    args: optionalStringArray(raw, 'args', ['{text}'], 'config.command.args'),
    textMode: optionalEnum(raw, 'textMode', ['stdin', 'arg', 'file'], 'stdin', 'config.command.textMode'),
    outFormat: optionalEnum(raw, 'outFormat', ['wav', 'mp3'], 'wav', 'config.command.outFormat'),
    voice: optionalString(raw, 'voice', null, 'config.command.voice'),
    voices: [...voices],
    timeoutMs: optionalPositiveNumber(raw, 'timeoutMs', 120_000, 'config.command.timeoutMs'),
  }
}

/**
 * Validate and normalize the row's config.
 *
 * Misconfiguration fails loud here, at activation, rather than surfacing later as a confusing tool
 * error. Nothing here is required: with an empty config the plugin synthesizes through Edge, and
 * `tts_setup {action:"status"}` says whether that is reachable from this machine right now.
 *
 * @param {object} [raw] - the row's `config`.
 * @param {Record<string, string|undefined>} [env] - the environment, injected so a test can pin it.
 * @returns {object} the normalized config.
 * @throws {TypeError} when a field has the wrong type, or names an unknown provider.
 */
export function normalizeConfig(raw, env = process.env) {
  const config = raw ?? {}
  const edge = config.edge ?? {}
  const command = config.command === undefined || config.command === null ? null : normalizeCommand(config.command)

  const provider =
    optionalString(config, 'provider', null, 'config.provider') ??
    (typeof env[ENV_KEYS.provider] === 'string' && env[ENV_KEYS.provider] !== '' ? env[ENV_KEYS.provider] : null) ??
    'edge'
  if (!PROVIDER_IDS.includes(provider)) {
    throw new TypeError(`dsh-tts: config.provider must be one of ${PROVIDER_IDS.join(', ')}, got ${JSON.stringify(provider)}`)
  }

  const edgeVoice =
    optionalString(edge, 'voice', null, 'config.edge.voice') ??
    (typeof env[ENV_KEYS.voice] === 'string' && env[ENV_KEYS.voice] !== '' ? env[ENV_KEYS.voice] : null) ??
    DEFAULT_VOICE

  return {
    projectRoot: optionalString(config, 'projectRoot', null, 'config.projectRoot'),
    outDir:
      optionalString(config, 'outDir', null, 'config.outDir') ??
      (typeof env[ENV_KEYS.outDir] === 'string' && env[ENV_KEYS.outDir] !== '' ? env[ENV_KEYS.outDir] : null),
    provider,
    ffprobePath:
      optionalString(config, 'ffprobePath', null, 'config.ffprobePath') ??
      (typeof env[ENV_KEYS.ffprobe] === 'string' && env[ENV_KEYS.ffprobe] !== '' ? env[ENV_KEYS.ffprobe] : null),
    edge: {
      voice: edgeVoice,
      rate: optionalString(edge, 'rate', '+0%', 'config.edge.rate'),
      pitch: optionalString(edge, 'pitch', '+0Hz', 'config.edge.pitch'),
      volume: optionalString(edge, 'volume', '+0%', 'config.edge.volume'),
      timeoutMs: optionalPositiveNumber(edge, 'timeoutMs', 60_000, 'config.edge.timeoutMs'),
    },
    command,
  }
}

/**
 * Mount the tools.
 *
 * Registration is wrapped so a failure to reach the `tools` service is logged clearly instead of
 * looking like a silent no-op: a plugin that loads but exposes nothing is the hardest kind of
 * failure to notice.
 *
 * @param {object} ctx - plugin context.
 * @param {object} rawConfig - the row's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    ctx.logger.error(`dsh-tts: 配置无效，插件未注册任何工具：${error.message}`)
    return
  }

  ctx.inject(['tools'], (toolsCtx) => {
    const outcome = registerTools(toolsCtx, config, ctx.logger)
    if (outcome.registered.length === 0) {
      ctx.logger.error('dsh-tts: 没有注册任何工具，插件实际上不可用')
    }
  })
}
