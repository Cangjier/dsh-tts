/**
 * The `command` provider: any local text-to-speech engine that has a command line.
 *
 * WHY A TEMPLATE RATHER THAN AN ENGINE LIST
 * -----------------------------------------
 * Piper, Kokoro, GPT-SoVITS, IndexTTS, a Python script someone wrote last week — they all differ
 * in flags, in whether the text goes on stdin or in a file, in whether the output is WAV or MP3,
 * and in whether they print timings at all. Encoding a table of engines would mean this plugin
 * needs a release every time one of them moves. A template with placeholders does not: the plugin
 * knows how to build an argument list, put text where the engine wants it, and read back what the
 * engine wrote.
 *
 * The placeholders are `{out}`, `{text}`, `{textFile}`, `{voice}`, `{rate}` and `{timings}`.
 * `{out}` is required — an engine that writes nowhere produces nothing this plugin can return.
 *
 * TIMINGS ARE OPTIONAL AND NEVER INVENTED
 * ---------------------------------------
 * Most local engines report no word boundaries. This provider therefore returns `timings: "none"`
 * and an empty word list, which downstream code can see and act on, rather than a plausible-looking
 * estimate. An engine that *can* emit timings declares it by putting `{timings}` in the template:
 * the plugin passes a path, and if a JSON file with `[{text,start,end}]` (or `{words:[...]}`) is
 * there afterwards, those timings are returned as `timings: "engine-json"`.
 *
 * @module dsh-tts/core/providers/command
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TtsError } from '../errors.mjs'

/** Stable provider id, as it appears in `config.provider`. */
export const PROVIDER_ID = 'command'

/** Default timeout for one synthesis run. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Largest audio file this provider will read back, so a runaway engine cannot exhaust memory. */
const MAX_AUDIO_BYTES = 512 * 1024 * 1024

/**
 * Substitute the placeholders in one argument template.
 *
 * Only the known placeholders are replaced; anything else — including a literal brace argument an
 * engine may want — is left exactly as written.
 *
 * @param {string} template - one argument or the command path.
 * @param {Record<string, string>} values - the substitution values.
 * @returns {string} the substituted argument.
 */
export function fillPlaceholders(template, values) {
  return template.replace(/\{(out|text|textFile|voice|rate|timings)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? values[name] : match,
  )
}

/**
 * Which placeholders a template list uses.
 * @param {string[]} templates - the argument templates.
 * @returns {Set<string>} the placeholder names used.
 */
export function placeholdersIn(templates) {
  const found = new Set()
  for (const template of templates) {
    for (const match of template.matchAll(/\{(out|text|textFile|voice|rate|timings)\}/g)) found.add(match[1])
  }
  return found
}

/**
 * Normalize an engine's timing file into this plugin's word shape.
 *
 * Accepts a bare array or `{words: [...]}`, and drops any entry that is not a readable
 * `{text, start, end}` — a malformed timing must cost the timing, never the audio.
 *
 * @param {string} payload - the file's text.
 * @returns {{text: string, start: number, end: number}[]} the words found.
 */
export function parseTimingsFile(payload) {
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.words) ? parsed.words : []
  const words = []
  for (const entry of list) {
    const text = typeof entry?.text === 'string' ? entry.text : null
    const start = Number(entry?.start)
    const end = Number(entry?.end)
    if (text === null || text === '' || !Number.isFinite(start) || !Number.isFinite(end)) continue
    words.push({ text, start, end })
  }
  return words.sort((left, right) => left.start - right.start)
}

/**
 * Build the `command` provider for one normalized config.
 *
 * @param {object|null} config - `config.command` from the plugin config, or null when unset.
 * @returns {object} the provider.
 */
export function commandProvider(config) {
  const configured = config !== null && config !== undefined
  const outExtension = configured ? config.outFormat : 'wav'
  const templateUses = configured ? placeholdersIn(config.args) : new Set()

  /**
   * Report what this provider is, without running anything.
   * @returns {object} the status.
   */
  const status = () => ({
    id: PROVIDER_ID,
    available: configured,
    requiresNetwork: false,
    requiresKey: false,
    keyless: true,
    timings: templateUses.has('timings') ? 'engine-json' : 'none',
    timingsNote: templateUses.has('timings')
      ? '模板里有 {timings}：引擎若在该路径写出 [{text,start,end}] 或 {words:[...]}，会被原样读回。'
      : '模板里没有 {timings}，所以没有逐词时间戳；需要的话用强制对齐（WhisperX / MFA）从音频反推。',
    ...(configured
      ? {
          path: config.path,
          textMode: config.textMode,
          outFormat: config.outFormat,
          voice: config.voice,
          binaryPresent: existsSync(config.path),
          notes: existsSync(config.path) ? [] : [`配置的命令不存在：${config.path}`],
        }
      : { notes: ['config.command 未配置：本地引擎要显式给出命令行模板。'] }),
  })

  /**
   * Run the configured command for one utterance.
   *
   * @param {object} input - the request.
   * @param {string} input.text - the text to speak.
   * @param {string} [input.voice] - value for `{voice}`; falls back to `config.command.voice`.
   * @param {string} [input.rate] - value for `{rate}`.
   * @param {number} [input.timeoutMs] - give up after this long.
   * @returns {Promise<{audio: Buffer, words: object[], duration: number, timings: string, meta: object}>} what came back.
   * @throws {TtsError} when the provider is unconfigured, the binary is missing, the run fails, or no audio was written.
   */
  const speak = async (input) => {
    if (!configured) {
      throw new TtsError(
        'command: 没有配置本地引擎。请在插件 config.command 里给出 {path, args}（模板必须含 {out}），或改用 provider:"edge"。',
      )
    }
    const text = typeof input?.text === 'string' ? input.text : ''
    if (text.trim() === '') throw new TtsError('command: 文本为空，无法合成语音')
    if (!existsSync(config.path)) throw new TtsError(`command: 找不到命令 ${config.path}`)
    if (!templateUses.has('out')) {
      throw new TtsError('command: args 模板里必须有 {out}（引擎写出的音频文件路径），否则没有可返回的音频。')
    }

    const timeoutMs = input?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const workDir = mkdtempSync(join(tmpdir(), 'dsh-tts-'))
    const outPath = join(workDir, `speech.${outExtension}`)
    const textPath = join(workDir, 'text.txt')
    const timingsPath = join(workDir, 'timings.json')
    const usesTextFile = templateUses.has('textFile') || config.textMode === 'file'

    writeFileSync(textPath, text, 'utf8')

    const values = {
      out: outPath,
      text,
      textFile: textPath,
      timings: timingsPath,
      voice: input?.voice ?? config.voice ?? '',
      rate: input?.rate ?? '',
    }
    const args = config.args.map((template) => fillPlaceholders(template, values))
    const command = fillPlaceholders(config.path, values)

    /**
     * Run the process and resolve with its exit code and stderr.
     * @returns {Promise<{code: number|null, stderr: string, timedOut: boolean}>} the outcome.
     */
    const run = () =>
      new Promise((settle) => {
        const child = spawn(command, args, {
          windowsHide: true,
          stdio: [config.textMode === 'stdin' ? 'pipe' : 'ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, timeoutMs)

        child.stderr.on('data', (chunk) => {
          // Bounded: a chatty engine must not be able to grow this without limit.
          if (stderr.length < 8192) stderr += chunk.toString('utf8')
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          settle({ code: null, stderr: `${stderr}\n${error.message}`.trim(), timedOut })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          settle({ code, stderr: stderr.trim(), timedOut })
        })

        if (config.textMode === 'stdin' && child.stdin !== null) {
          child.stdin.on('error', () => {}) // an engine that exits early closes the pipe
          child.stdin.end(text, 'utf8')
        }
      })

    try {
      const outcome = await run()
      if (outcome.timedOut) {
        throw new TtsError(`command: 引擎超时（${timeoutMs}ms）：${command}`)
      }
      if (outcome.code !== 0) {
        const detail = outcome.stderr === '' ? '' : `：${outcome.stderr.split('\n').slice(0, 3).join(' / ')}`
        throw new TtsError(`command: 引擎退出码 ${outcome.code}${detail}`)
      }
      if (!existsSync(outPath)) {
        throw new TtsError(`command: 引擎没有写出 ${outPath}；模板里的 {out} 是否被引擎真正使用？`)
      }
      const audio = readFileSync(outPath)
      if (audio.length === 0) throw new TtsError(`command: 引擎写出的文件是空的：${outPath}`)
      if (audio.length > MAX_AUDIO_BYTES) throw new TtsError(`command: 引擎写出的文件过大（${audio.length} 字节）`)

      const words = templateUses.has('timings') && existsSync(timingsPath) ? parseTimingsFile(readFileSync(timingsPath, 'utf8')) : []
      return {
        audio,
        words,
        duration: words.length > 0 ? words[words.length - 1].end : null,
        timings: words.length > 0 ? 'engine-json' : 'none',
        meta: {
          command,
          args,
          textMode: config.textMode,
          outFormat: config.outFormat,
          voice: values.voice,
          rate: values.rate,
          stderr: outcome.stderr === '' ? null : outcome.stderr.split('\n').slice(0, 5),
        },
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  /**
   * The voices this provider can offer: the ones the config names, plus the configured default.
   *
   * There is no way to ask an arbitrary command line what voices it has, so this reports the list
   * the caller configured and says so, rather than implying it is exhaustive.
   * @returns {Promise<{voices: object[], total: number, source: string}>} the voices.
   */
  const voices = async () => {
    const names = configured ? [...config.voices] : []
    if (configured && config.voice !== null && !names.includes(config.voice)) names.unshift(config.voice)
    return {
      voices: names.map((shortName) => ({
        shortName,
        locale: '',
        gender: null,
        friendlyName: null,
        personalities: [],
        categories: [],
        status: null,
      })),
      total: names.length,
      source: 'config.command.voices（命令行引擎无法自报音色，这里只回显配置里写下的那些）',
    }
  }

  return {
    id: PROVIDER_ID,
    kind: 'local',
    requiresNetwork: false,
    timings: templateUses.has('timings') ? 'engine-json' : 'none',
    defaults: { voice: configured ? config.voice : null, rate: null, timeoutMs: configured ? config.timeoutMs : DEFAULT_TIMEOUT_MS },
    outputExtension: outExtension,
    speak,
    voices,
    status,
  }
}
