#!/usr/bin/env node
/**
 * The command line this plugin can be driven from without a host.
 *
 * Why it exists: a plugin whose only entry point is a tool call can only be debugged through the
 * harness, and "it works in the model's turn but not on this machine" is exactly the failure this
 * file removes. Every subcommand below calls the same core the tools call, so what it prints is
 * what a tool would return — the difference is that here it can be run on a bare checkout.
 *
 *   node src/bin/tts.mjs doctor
 *   node src/bin/tts.mjs voices --locale zh --limit 20
 *   node src/bin/tts.mjs say "测试一句话" --voice zh-CN-YunxiNeural
 *   node src/bin/tts.mjs check
 *   node src/bin/tts.mjs dialogue --script script.txt --voices host-a=zh-CN-XiaoxiaoNeural,host-b=zh-CN-YunxiNeural
 *   node src/bin/tts.mjs rules
 *
 * @module dsh-tts/bin/tts
 */
import { readFileSync } from 'node:fs'
import { normalizeConfig } from '../../index.mjs'
import { createSetupActions, createSpeakActions } from '../tools/actions.mjs'
import { createGuideActions } from '../tools/guide.mjs'
import { toolDefinitions } from '../tools/index.mjs'

/** A logger that reports to stderr, so stdout stays parseable JSON. */
const logger = {
  info: (message) => console.error(`[dsh-tts] ${message}`),
  warn: (message) => console.error(`[dsh-tts] warn: ${message}`),
  error: (message) => console.error(`[dsh-tts] error: ${message}`),
}

/**
 * Parse `--flag value` and `--flag=value` arguments into a map, leaving positionals in `_`.
 * @param {string[]} argv - the arguments after the subcommand.
 * @returns {{_: string[], flags: Record<string, string|boolean>}} the parsed arguments.
 */
function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    if (equals > 0) {
      flags[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true
      continue
    }
    flags[name] = next
    index += 1
  }
  return { _: positionals, flags }
}

/**
 * Turn `a=Voice,b=Voice` into the voice map the dialogue action expects.
 * @param {string|boolean|undefined} value - the flag value.
 * @returns {Record<string,string>} the map.
 */
function parseVoices(value) {
  if (typeof value !== 'string' || value === '') return {}
  const map = {}
  for (const pair of value.split(',')) {
    const equals = pair.indexOf('=')
    if (equals <= 0) continue
    map[pair.slice(0, equals).trim()] = pair.slice(equals + 1).trim()
  }
  return map
}

/**
 * Build the config the CLI runs with: the environment, plus whatever the flags name.
 * @param {Record<string, string|boolean>} flags - the parsed flags.
 * @returns {object} the normalized config.
 */
function configFrom(flags) {
  const raw = {
    provider: typeof flags.provider === 'string' ? flags.provider : null,
    outDir: typeof flags['out-dir'] === 'string' ? flags['out-dir'] : null,
    ffprobePath: typeof flags.ffprobe === 'string' ? flags.ffprobe : null,
    edge: {
      voice: typeof flags.voice === 'string' ? flags.voice : null,
      rate: typeof flags.rate === 'string' ? flags.rate : null,
    },
  }
  if (typeof flags.command === 'string') {
    raw.command = {
      path: flags.command,
      args: typeof flags['command-args'] === 'string' ? flags['command-args'].split('|') : ['{text}'],
      textMode: typeof flags['text-mode'] === 'string' ? flags['text-mode'] : 'stdin',
      outFormat: typeof flags['out-format'] === 'string' ? flags['out-format'] : 'wav',
    }
  }
  return normalizeConfig(raw)
}

/**
 * The `measure` argument, unless `--no-measure` was passed.
 * @param {Record<string, string|boolean>} flags - the parsed flags.
 * @returns {boolean|undefined} false to skip measuring, undefined to keep the default.
 */
const measureFlag = (flags) => (flags['no-measure'] === true ? false : undefined)

/**
 * Run one subcommand and print its result as JSON.
 * @returns {Promise<void>} resolves when the command has finished.
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { _, flags } = parseArgs(rest)
  const cwd = process.cwd()

  if (command === undefined || command === 'help' || command === '--help') {
    console.log('用法：tts.mjs <doctor|voices|say|check|dialogue|rules> [参数]\n见 src/bin/tts.mjs 顶部注释里的例子。')
    return
  }

  const config = configFrom(flags)

  if (command === 'doctor') {
    console.log(JSON.stringify(await createSetupActions(config, logger).status({}, { cwd }), null, 2))
    return
  }

  if (command === 'voices') {
    const result = await createSetupActions(config, logger).voices(
      {
        provider: typeof flags.provider === 'string' ? flags.provider : undefined,
        locale: typeof flags.locale === 'string' ? flags.locale : undefined,
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
      },
      { cwd },
    )
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'check') {
    const result = await createSetupActions(config, logger).check(
      {
        provider: typeof flags.provider === 'string' ? flags.provider : undefined,
        text: typeof flags.text === 'string' ? flags.text : undefined,
        voice: typeof flags.voice === 'string' ? flags.voice : undefined,
        rate: typeof flags.rate === 'string' ? flags.rate : undefined,
        measure: measureFlag(flags),
      },
      { cwd },
    )
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'say') {
    const text = typeof flags.text === 'string' ? flags.text : _[0]
    if (text === undefined || text === '') {
      console.error('say 需要文本：tts.mjs say "要念的话" [--voice 音色] [--out 文件]')
      process.exitCode = 2
      return
    }
    const result = await createSpeakActions(config, logger).speak(
      {
        text,
        provider: typeof flags.provider === 'string' ? flags.provider : undefined,
        voice: typeof flags.voice === 'string' ? flags.voice : undefined,
        rate: typeof flags.rate === 'string' ? flags.rate : undefined,
        outPath: typeof flags.out === 'string' ? flags.out : undefined,
        outDir: typeof flags['out-dir'] === 'string' ? flags['out-dir'] : undefined,
        measure: measureFlag(flags),
      },
      { cwd },
    )
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'dialogue') {
    const scriptPath = typeof flags.script === 'string' ? flags.script : undefined
    const inline = typeof flags['script-text'] === 'string' ? flags['script-text'] : _[0]
    // No script on the command line means it is being piped in.
    const script = scriptPath === undefined && inline === undefined ? readFileSync(0, 'utf8') : inline
    const result = await createSpeakActions(config, logger).dialogue(
      {
        script,
        scriptPath,
        voices: parseVoices(flags.voices),
        gapSeconds: flags.gap === undefined ? undefined : Number(flags.gap),
        outDir: typeof flags['out-dir'] === 'string' ? flags['out-dir'] : undefined,
        provider: typeof flags.provider === 'string' ? flags.provider : undefined,
        measure: measureFlag(flags),
      },
      { cwd },
    )
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'rules') {
    const guide = createGuideActions(() => toolDefinitions(config, logger))
    console.log(JSON.stringify(await guide.rules(), null, 2))
    return
  }

  console.error(`未知子命令：${command}；可用：doctor / voices / say / check / dialogue / rules`)
  process.exitCode = 2
}

main().catch((error) => {
  console.error(`[dsh-tts] 失败：${error?.message ?? error}`)
  process.exitCode = 1
})
