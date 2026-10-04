/**
 * The `tts_speak` / `tts_setup` actions: the syntheses and the questions about them.
 *
 * The handlers are thin on purpose. Each one resolves paths and providers, states the defaults it
 * applied, calls one provider method, and returns what came back unchanged. Anything that looks
 * like a decision — which voice belongs to which speaker, how long a pause should be, whether a
 * take is good — is not made here; it is either supplied in the arguments or left as a number.
 *
 * Determinism is reported, not asserted. Every result echoes the provider that answered, the voice
 * and prosody that were requested, where the file was written, and — when ffprobe is around — how
 * long the file really is beside the duration the engine claimed. The difference between those two
 * numbers is the trailing silence, and it is the number a timeline has to know.
 *
 * @module dsh-tts/tools/actions
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { TtsError } from '../core/errors.mjs'
import { buildWordsDocument, resolveAudioPath, resolveOutDir, writeAudioFile, writeJson, writeSidecar, wordsPathFor } from '../core/output.mjs'
import { chooseProvider, createProviders, providerStatuses, resolveProvider, speakRequest } from '../core/providers/index.mjs'
import { dialogueDocument, parseScript, planTimeline, verifyClips } from '../core/dialogue.mjs'
import { ffprobeCandidates, findFfprobe, probeDurationSeconds } from '../core/probe.mjs'

/** The phrase `check` speaks when the caller does not name one. */
const DEFAULT_CHECK_TEXT = '这是一次语音自检，用来确认合成引擎可用。'

/** Default number of voices `voices` returns before it stops listing. */
const DEFAULT_VOICE_LIMIT = 100

/** Which tool owns each action, so a refusal can name the call the caller should retry. */
const TOOL_OF = {
  speak: 'tts_speak',
  dialogue: 'tts_speak',
  status: 'tts_setup',
  voices: 'tts_setup',
  check: 'tts_setup',
}

/**
 * The `tts_speak <action>` / `tts_setup <action>` prefix for one action's messages.
 * @param {string} action - the action name.
 * @returns {string} the prefix, without the trailing colon.
 */
const label = (action) => `${TOOL_OF[action] ?? 'tts_speak'} ${action}`

/**
 * Turn a speaker name into a filesystem-safe file stem.
 * @param {string} value - the speaker name.
 * @returns {string} the stem, never empty.
 */
function slug(value) {
  const cleaned = `${value}`
    .replace(/[^0-9A-Za-z\u4e00-\u9fff._-]+/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
  return cleaned === '' ? 'line' : cleaned.slice(0, 40)
}

/**
 * Round a number of seconds for a result, keeping three decimals.
 * @param {number} value - the seconds.
 * @returns {number} the rounded value.
 */
const seconds = (value) => Number(value.toFixed(3))

/**
 * Resolve the working directory for one call.
 * @param {object} config - the normalized plugin config.
 * @param {object} context - the tool context.
 * @returns {string} the absolute directory.
 */
function cwdOf(config, context) {
  if (typeof context?.cwd === 'string' && context.cwd !== '') return context.cwd
  if (typeof config.projectRoot === 'string' && config.projectRoot !== '') return config.projectRoot
  return process.cwd()
}

/**
 * Decide what duration a synthesis result is worth.
 *
 * Three different facts can be behind one number, and the result says which: the engine's own word
 * timings, the engine's timing file, or the decoded length of the file. Only the first two say when
 * the speech stopped; the third says how long the file is, including whatever silence the engine
 * appended.
 *
 * @param {object} providerResult - what the provider returned.
 * @param {number|null} audioSeconds - the decoded length, when it was measured.
 * @returns {{durationSeconds: number|null, durationSource: string, tailSilenceSeconds: number|null}} the verdict.
 */
function settleDuration(providerResult, audioSeconds) {
  const reported = typeof providerResult.duration === 'number' && providerResult.duration > 0 ? providerResult.duration : null
  if (reported !== null) {
    return {
      durationSeconds: reported,
      durationSource: providerResult.timings === 'engine-json' ? 'engine-json' : 'word-boundaries',
      tailSilenceSeconds: audioSeconds === null ? null : seconds(Math.max(0, audioSeconds - reported)),
    }
  }
  if (audioSeconds !== null) {
    // The file length is known; where the speech stopped in it is not.
    return { durationSeconds: audioSeconds, durationSource: 'ffprobe', tailSilenceSeconds: null }
  }
  return { durationSeconds: null, durationSource: 'unavailable', tailSilenceSeconds: null }
}

/**
 * Build the `tts_speak` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @param {object} [overrides] - injection points used by the tests.
 * @param {Map<string, object>} [overrides.providers] - a provider map to use instead of building one.
 * @returns {Record<string, Function>} action handlers.
 */
export function createSpeakActions(config, logger, overrides = {}) {
  const providers = overrides.providers ?? createProviders(config)
  const ffprobe = findFfprobe(config.ffprobePath)

  /**
   * Read the text a call asked to speak.
   * @param {object} args - the arguments.
   * @param {string} cwd - the working directory.
   * @param {string} action - the action name, for the message.
   * @returns {string} the text.
   * @throws {TtsError} when neither text nor textPath yields anything readable.
   */
  const readText = (args, cwd, action) => {
    let text = typeof args.text === 'string' ? args.text : ''
    if (text.trim() === '' && typeof args.textPath === 'string' && args.textPath !== '') {
      const path = resolve(cwd, args.textPath)
      if (!existsSync(path)) throw new TtsError(`${label(action)}: 找不到文案文件 ${path}`)
      text = readFileSync(path, 'utf8')
      // Strip a BOM: PowerShell's default UTF-8 writer emits one.
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    if (text.trim() === '') {
      throw new TtsError(`${label(action)}: 需要 "text"（内联文案）或 "textPath"（文案文件）。`)
    }
    return text
  }

  /**
   * Synthesize one utterance and write it with its sidecar.
   *
   * @param {object} options - the request.
   * @param {object} options.args - the caller's arguments, plus the resolved `name`.
   * @param {string} options.cwd - the working directory.
   * @param {object} options.provider - the resolved provider.
   * @param {string} options.outDir - where to write.
   * @param {string} options.text - what to say.
   * @param {object} [options.extraMeta] - provenance to add, such as the dialogue line number.
   * @returns {Promise<object>} the paths, the measurement and the sidecar document.
   */
  const synthesizeOne = async (options) => {
    const { args, cwd, provider, outDir, text, extraMeta = {} } = options
    const request = speakRequest(config, provider, { ...args, text })
    const startedAt = Date.now()
    const providerResult = await provider.speak(request)
    const elapsedMs = Date.now() - startedAt

    const audioPath = resolveAudioPath(args, cwd, outDir, provider.outputExtension)
    const wordsPath = wordsPathFor(audioPath)
    // Audio first, measurement second, sidecar third: ffprobe can only answer about a file that is
    // already on disk, and the sidecar is where its answer goes.
    writeAudioFile(audioPath, providerResult.audio)
    const measurement =
      args.measure === false ? { seconds: null, error: 'measure:false，未核对文件时长' } : await probeDurationSeconds(audioPath, ffprobe)
    const duration = settleDuration(providerResult, measurement.seconds)

    const document = buildWordsDocument({
      audioPath,
      provider: provider.id,
      voice: request.voice ?? null,
      text,
      words: providerResult.words ?? [],
      durationSeconds: duration.durationSeconds,
      durationSource: duration.durationSource,
      audioSeconds: measurement.seconds,
      tailSilenceSeconds: duration.tailSilenceSeconds,
      timings: providerResult.timings ?? provider.timings,
      meta: { ...providerResult.meta, ...extraMeta },
    })
    writeSidecar(wordsPath, document)

    return { audio: audioPath, wordsPath, bytes: providerResult.audio.length, elapsedMs, measurement, document }
  }

  return {
    /**
     * Synthesize one piece of text.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the paths and the numbers.
     */
    async speak(args, context) {
      const cwd = cwdOf(config, context)
      const text = readText(args, cwd, 'speak')
      const { provider, reason } = chooseProvider(providers, config, args.provider)
      const outDir = resolveOutDir(config, args, cwd)

      const result = await synthesizeOne({ args, cwd, provider, outDir, text })
      logger.info(
        `dsh-tts: ${provider.id} 合成 ${text.length} 字，${result.document.wordCount} 个词，` +
          `${result.document.duration ?? '未知'}s → ${result.audio}`,
      )

      return {
        provider: provider.id,
        providerReason: reason,
        voice: result.document.voice,
        audio: result.audio,
        wordsPath: result.wordsPath,
        bytes: result.bytes,
        elapsedMs: result.elapsedMs,
        timings: result.document.timings,
        wordCount: result.document.wordCount,
        durationSeconds: result.document.duration,
        durationSource: result.document.durationSource,
        audioSeconds: result.document.audioSeconds,
        tailSilenceSeconds: result.document.tailSilenceSeconds,
        ...(result.measurement.error === null ? {} : { measureNote: result.measurement.error }),
      }
    },

    /**
     * Synthesize a multi-speaker script and lay it on one timeline.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the manifest, the clips and the global word timings.
     */
    async dialogue(args, context) {
      const cwd = cwdOf(config, context)
      const outDir = resolveOutDir(config, args, cwd)
      const { provider, reason } = chooseProvider(providers, config, args.provider)

      // A timeline needs one duration per line. A provider that reports none needs ffprobe, and
      // saying so before synthesizing twenty lines is the difference between a hint and a wait.
      if (provider.timings === 'none' && (ffprobe === null || args.measure === false)) {
        throw new TtsError(
          `${label('dialogue')}: provider "${provider.id}" 不报时长，而 ffprobe ${
            ffprobe === null ? '在这台机器上找不到' : '被 measure:false 关掉了'
          }。装一个 ffprobe（或把它放进 PATH / 同级 dsh-video-audio 的 vendor），再调用一次。`,
        )
      }

      const voiceMap =
        args.voices !== undefined && args.voices !== null && typeof args.voices === 'object' && !Array.isArray(args.voices) ? args.voices : {}
      const declaredSpeakers = Array.isArray(args.speakers) && args.speakers.length > 0 ? args.speakers : Object.keys(voiceMap)

      let turns
      let unknownTokens = []
      if (Array.isArray(args.lines) && args.lines.length > 0) {
        turns = args.lines.map((line, index) => {
          if (typeof line?.speaker !== 'string' || typeof line?.text !== 'string' || line.text.trim() === '') {
            throw new TtsError(`${label('dialogue')}: lines[${index}] 需要 {speaker, text}，且 text 不能为空。`)
          }
          return { speaker: line.speaker, text: line.text.trim(), line: index + 1 }
        })
      } else {
        let script = typeof args.script === 'string' ? args.script : ''
        if (script.trim() === '' && typeof args.scriptPath === 'string' && args.scriptPath !== '') {
          const path = resolve(cwd, args.scriptPath)
          if (!existsSync(path)) throw new TtsError(`${label('dialogue')}: 找不到脚本文件 ${path}`)
          script = readFileSync(path, 'utf8')
          if (script.charCodeAt(0) === 0xfeff) script = script.slice(1)
        }
        if (script.trim() === '') {
          throw new TtsError(`${label('dialogue')}: 需要 "script"（内联脚本）、"scriptPath"（脚本文件）或 "lines"（结构化台词）。`)
        }
        const parsed = parseScript(script, { speakers: declaredSpeakers })
        turns = parsed.turns
        unknownTokens = parsed.unknownTokens
      }

      // One bad line must not be able to overwrite the others: `outPath` names one file, and a
      // dialogue writes many.
      const baseArgs = { ...args }
      delete baseArgs.outPath
      delete baseArgs.name

      const linesDir = join(outDir, 'lines')
      const startedAt = Date.now()
      const entries = []
      const usedVoices = new Map()

      for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index]
        const requestedVoice =
          typeof voiceMap[turn.speaker] === 'string' && voiceMap[turn.speaker] !== '' ? voiceMap[turn.speaker] : args.voice
        const stem = `${String(index + 1).padStart(3, '0')}-${slug(turn.speaker)}`

        const result = await synthesizeOne({
          args: { ...baseArgs, voice: requestedVoice, name: stem },
          cwd,
          provider,
          outDir: linesDir,
          text: turn.text,
          extraMeta: { dialogueLine: index + 1, speaker: turn.speaker },
        })

        // The voice that actually answered, not the one that was asked for: a provider with no
        // voice concept returns null, and the manifest must show that rather than a hopeful name.
        const actualVoice = result.document.voice ?? null
        const key = actualVoice ?? '(引擎默认)'
        if (!usedVoices.has(key)) usedVoices.set(key, new Set())
        usedVoices.get(key).add(turn.speaker)

        entries.push({
          speaker: turn.speaker,
          text: turn.text,
          audio: result.audio,
          source: result.audio,
          duration: result.document.duration,
          words: result.document.words,
          voice: actualVoice,
          audioSeconds: typeof result.document.audioSeconds === 'number' ? result.document.audioSeconds : null,
        })
        logger.info(`dsh-tts: 第 ${index + 1}/${turns.length} 行 ${turn.speaker} → ${basename(result.audio)}`)
      }

      const plan = planTimeline(entries, {
        gapSeconds: args.gapSeconds,
        tailPadSeconds: args.tailPadSeconds,
        tailSeconds: args.tailSeconds,
      })

      // A speaker with several lines is still one speaker: only a voice used by two *different*
      // speakers makes the conversation sound like one person talking to themselves.
      const sharedVoices = [...usedVoices.entries()]
        .filter(([, speakers]) => speakers.size > 1)
        .map(([voice, speakers]) => ({ voice, speakers: [...speakers] }))

      const manifestPath = join(outDir, 'dialogue.json')
      const wordsPath = join(outDir, 'dialogue.words.json')
      const timings = provider.timings
      const verification = verifyClips(
        plan.lines,
        entries.map((entry) => entry.audioSeconds),
      )
      const manifest = dialogueDocument({
        outDir,
        provider: provider.id,
        voices: voiceMap,
        gapSeconds: args.gapSeconds ?? 0.35,
        tailPadSeconds: args.tailPadSeconds ?? 0.12,
        tailSeconds: args.tailSeconds ?? 0.5,
        plan,
        entries,
        sharedVoices,
        unknownTokens,
        verification,
      })
      writeJson(manifestPath, manifest)
      writeJson(wordsPath, {
        audio: null,
        provider: provider.id,
        voice: null,
        duration: plan.totalSeconds,
        durationSource: 'timeline',
        audioSeconds: null,
        tailSilenceSeconds: null,
        timings,
        wordCount: plan.words.length,
        manifest: manifestPath,
        clips: plan.clips,
        words: plan.words.map((word) => ({ text: word.text, start: word.start, end: word.end, speaker: word.speaker })),
      })

      logger.info(
        `dsh-tts: 对话合成完成 ${plan.lines.length} 行，${plan.totalSeconds}s，${plan.words.length} 个词 → ${manifestPath}`,
      )

      return {
        provider: provider.id,
        providerReason: reason,
        manifest: manifestPath,
        wordsPath,
        voices: voiceMap,
        lineCount: plan.lines.length,
        totalSeconds: plan.totalSeconds,
        wordCount: plan.words.length,
        timings,
        elapsedMs: Date.now() - startedAt,
        lines: plan.lines.map((line, index) => ({ ...line, voice: entries[index].voice, chars: entries[index].text.length })),
        clips: plan.clips,
        verification,
        sharedVoices,
        unknownSpeakerTokens: unknownTokens,
        next: 'audio_build {action:"assemble"} 的 clips 参数可以直接用上面的 clips；字幕用 wordsPath。',
      }
    },
  }
}

/**
 * Build the `tts_setup` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @param {object} [overrides] - injection points used by the tests.
 * @param {Map<string, object>} [overrides.providers] - a provider map to use instead of building one.
 * @returns {Record<string, Function>} action handlers.
 */
export function createSetupActions(config, logger, overrides = {}) {
  const providers = overrides.providers ?? createProviders(config)
  const ffprobe = findFfprobe(config.ffprobePath)

  return {
    /**
     * Report what is available, without touching the network.
     *
     * This one never refuses: reporting that nothing works is the whole point of it, so an
     * unusable provider is described rather than thrown.
     *
     * @param {object} args - the arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the status.
     */
    async status(args, context) {
      const cwd = cwdOf(config, context)
      const configured = resolveProvider(providers, config.provider)
      const request = speakRequest(config, configured, {})
      return {
        node: process.version,
        platform: process.platform,
        providers: providerStatuses(providers, config),
        default: {
          provider: configured.id,
          available: configured.status().available,
          voice: request.voice ?? null,
          rate: request.rate ?? null,
          outDir: resolveOutDir(config, args, cwd),
          commandConfigured: config.command !== null,
        },
        ffprobe: {
          path: ffprobe === null ? null : ffprobe.path,
          source: ffprobe === null ? null : ffprobe.source,
          candidates: ffprobeCandidates(config.ffprobePath).map((candidate) => ({ path: candidate.path, source: candidate.source })),
          note: 'ffprobe 只用来核对写出的文件有多长；没有它，不报时长的引擎无法做对话排版。',
        },
        config: {
          provider: config.provider,
          edge: {
            voice: config.edge.voice,
            rate: config.edge.rate,
            pitch: config.edge.pitch,
            volume: config.edge.volume,
            timeoutMs: config.edge.timeoutMs,
          },
          command:
            config.command === null
              ? null
              : {
                  path: config.command.path,
                  textMode: config.command.textMode,
                  outFormat: config.command.outFormat,
                  voice: config.command.voice,
                  argCount: config.command.args.length,
                },
          outDir: config.outDir,
        },
        next: 'tts_setup {action:"check"} 真的合成一句，才能证明这台机器现在可用。',
      }
    },

    /**
     * List the voices an engine offers.
     * @param {object} args - the arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the voices.
     */
    async voices(args, context) {
      const { provider } = chooseProvider(providers, config, args.provider)
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_VOICE_LIMIT
      const locale = typeof args.locale === 'string' && args.locale !== '' ? args.locale : null

      let result
      if (provider.id === 'edge') {
        result = await provider.voices({ locale, timeoutMs: config.edge.timeoutMs })
      } else {
        result = await provider.voices()
        if (locale !== null) {
          const prefix = locale.toLowerCase()
          result = { ...result, voices: result.voices.filter((voice) => voice.locale.toLowerCase().startsWith(prefix)) }
        }
      }

      const all = result.voices
      const shown = all.slice(0, limit)
      return {
        provider: provider.id,
        source: result.source ?? result.url ?? 'edge 服务的音色表',
        locale,
        total: result.total ?? all.length,
        count: shown.length,
        truncated: all.length > shown.length,
        ...(result.attempts === undefined ? {} : { attempts: result.attempts }),
        voices: shown,
        note:
          provider.id === 'edge'
            ? '这份表是服务端此刻的目录，会变；写进 config 之前先确认一次。'
            : '命令行引擎无法自报音色：这里只是 config.command.voices 与 config.command.voice 的回显。',
      }
    },

    /**
     * Synthesize a short phrase and report exactly what came back.
     * @param {object} args - the arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the evidence.
     */
    async check(args, context) {
      const cwd = cwdOf(config, context)
      const { provider, reason } = chooseProvider(providers, config, args.provider)
      const outDir = resolveOutDir(config, args, cwd)
      const text = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : DEFAULT_CHECK_TEXT
      const request = speakRequest(config, provider, { ...args, text })

      const startedAt = Date.now()
      const providerResult = await provider.speak(request)
      const elapsedMs = Date.now() - startedAt

      const audioPath = resolveAudioPath({ name: `check-${provider.id}` }, cwd, outDir, provider.outputExtension)
      const wordsPath = wordsPathFor(audioPath)
      // Audio first, then the measurement, then the sidecar — see synthesizeOne for why the order
      // is not interchangeable.
      writeAudioFile(audioPath, providerResult.audio)
      const measurement = args.measure === false ? { seconds: null, error: 'measure:false' } : await probeDurationSeconds(audioPath, ffprobe)
      const settled = settleDuration(providerResult, measurement.seconds)

      const document = buildWordsDocument({
        audioPath,
        provider: provider.id,
        voice: request.voice ?? null,
        text,
        words: providerResult.words ?? [],
        durationSeconds: settled.durationSeconds,
        durationSource: settled.durationSource,
        audioSeconds: measurement.seconds,
        tailSilenceSeconds: settled.tailSilenceSeconds,
        timings: providerResult.timings ?? provider.timings,
        meta: { ...providerResult.meta, probe: true },
      })
      writeSidecar(wordsPath, document)
      logger.info(`dsh-tts: 自检 ${provider.id} 成功，${providerResult.audio.length} 字节，${elapsedMs}ms`)

      const words = document.words
      return {
        provider: provider.id,
        providerReason: reason,
        voice: document.voice,
        ok: true,
        timings: document.timings,
        bytes: providerResult.audio.length,
        wordCount: document.wordCount,
        durationSeconds: document.duration,
        durationSource: document.durationSource,
        audioSeconds: document.audioSeconds,
        tailSilenceSeconds: document.tailSilenceSeconds,
        elapsedMs,
        audio: audioPath,
        wordsPath,
        sample: { first: words[0] ?? null, last: words[words.length - 1] ?? null },
        ...(measurement.error === null ? {} : { measureNote: measurement.error }),
        note: '这个文件只是自检产物，可以随时删掉。',
      }
    },
  }
}
