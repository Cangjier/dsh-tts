/**
 * Provider resolution and the command provider's template arithmetic.
 *
 * The resolution order is pinned because two of its rules are not obvious: an explicit argument
 * beats the config, and a configured provider that is not usable falls through to one that is,
 * rather than failing a call the machine could have served.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TtsError } from '../src/core/errors.mjs'
import { normalizeConfig } from '../index.mjs'
import { chooseProvider, createProviders, providerStatuses, resolveProvider, speakRequest } from '../src/core/providers/index.mjs'
import { commandProvider, fillPlaceholders, parseTimingsFile, placeholdersIn } from '../src/core/providers/command.mjs'

/** A config with no command engine configured. */
const edgeOnly = () => normalizeConfig({}, {})

test('both providers are built, and an unknown id is refused with the list of real ones', () => {
  const providers = createProviders(edgeOnly())
  assert.deepEqual([...providers.keys()], ['edge', 'command'])
  assert.equal(resolveProvider(providers, 'edge').id, 'edge')
  assert.throws(() => resolveProvider(providers, 'xtts'), /未知的 provider/)
})

test('an explicit provider argument wins, then the config, then the first usable one', () => {
  const config = normalizeConfig({ provider: 'command' }, {})
  const providers = createProviders(config)

  assert.equal(chooseProvider(providers, config, 'edge').provider.id, 'edge')
  assert.equal(chooseProvider(providers, config, 'edge').reason, 'argument')

  // config.provider is "command", which is unusable without a config.command block, so the call
  // falls through to edge instead of failing.
  const chosen = chooseProvider(providers, config, undefined)
  assert.equal(chosen.provider.id, 'edge')
  assert.match(chosen.reason, /command 不可用/)
})

test('voice and prosody resolve per provider, and a provider that has no pitch is never handed one', () => {
  const config = normalizeConfig(
    { edge: { voice: 'zh-CN-YunxiNeural', rate: '-5%' }, command: { path: 'C:/tts/engine.exe', voice: 'zh_CN-huayan-medium' } },
    {},
  )
  const providers = createProviders(config)

  const forEdge = speakRequest(config, providers.get('edge'), { text: 'hi' })
  assert.deepEqual(forEdge, { text: 'hi', voice: 'zh-CN-YunxiNeural', rate: '-5%', pitch: '+0Hz', volume: '+0%', timeoutMs: 60_000 })
  assert.equal(speakRequest(config, providers.get('edge'), { text: 'hi', voice: 'zh-CN-XiaoyiNeural' }).voice, 'zh-CN-XiaoyiNeural')

  const forCommand = speakRequest(config, providers.get('command'), { text: 'hi' })
  assert.equal(forCommand.voice, 'zh_CN-huayan-medium')
  assert.equal(forCommand.rate, null)
  assert.equal(Object.hasOwn(forCommand, 'pitch'), false, 'a local engine is not given a pitch it never asked for')
})

test('defaults come from the environment when the config is silent, and an unknown one is refused', () => {
  const config = normalizeConfig({}, { DSH_TTS_PROVIDER: 'edge', DSH_TTS_VOICE: 'zh-CN-YunjianNeural', DSH_TTS_OUT_DIR: 'out' })
  assert.equal(config.provider, 'edge')
  assert.equal(config.edge.voice, 'zh-CN-YunjianNeural')
  assert.equal(config.outDir, 'out')
  assert.throws(() => normalizeConfig({ provider: 'xtts' }, {}), /config.provider must be one of/)
})

test('an unconfigured command provider reports itself as unavailable rather than pretending', () => {
  const provider = commandProvider(null)
  const status = provider.status()
  assert.equal(status.available, false)
  assert.equal(status.timings, 'none')
  assert.match(status.notes.join(' '), /config.command 未配置/)
  assert.equal(provider.outputExtension, 'wav')
})

test('a configured command provider notices a binary that is not there', () => {
  const provider = commandProvider({ path: 'C:/definitely/not/here.exe', args: ['--out', '{out}'], textMode: 'stdin', outFormat: 'wav', voice: null, voices: [], timeoutMs: 1000 })
  const status = provider.status()
  assert.equal(status.available, true)
  assert.equal(status.binaryPresent, false)
  assert.match(status.notes.join(' '), /配置的命令不存在/)
})

test('speaking through an unconfigured command provider is refused with the fix in the message', async () => {
  const provider = commandProvider(null)
  await assert.rejects(() => provider.speak({ text: 'hi' }), (error) => {
    assert.equal(error instanceof TtsError, true)
    assert.match(error.message, /provider:"edge"/)
    return true
  })
  // Once an engine is configured, the text is checked before anything is executed: an empty
  // utterance must not spend a process run discovering that.
  const configured = commandProvider({ path: 'engine.exe', args: ['{out}'], textMode: 'stdin', outFormat: 'wav', voice: null, voices: [], timeoutMs: 1000 })
  await assert.rejects(() => configured.speak({ text: '   ' }), /文本为空/)
})

test('placeholders are substituted by name and anything else is left alone', () => {
  const values = { out: 'o.wav', text: 'hello {world}', textFile: 't.txt', voice: 'v', rate: '+5%', timings: 'j.json' }
  assert.equal(fillPlaceholders('--out={out}', values), '--out=o.wav')
  assert.equal(fillPlaceholders('{text}', values), 'hello {world}')
  assert.equal(fillPlaceholders('--voice={voice}', values), '--voice=v')
  assert.equal(fillPlaceholders('{unknown}', values), '{unknown}')
  assert.deepEqual([...placeholdersIn(['{out}', '--v={voice}', '{nope}'])].sort(), ['out', 'voice'])
})

test('an engine timing file is normalized to the sidecar word shape, or dropped', () => {
  assert.deepEqual(parseTimingsFile('[{"text":"b","start":1,"end":2},{"text":"a","start":0,"end":1}]'), [
    { text: 'a', start: 0, end: 1 },
    { text: 'b', start: 1, end: 2 },
  ])
  assert.deepEqual(parseTimingsFile('{"words":[{"text":"x","start":0,"end":0.5}]}'), [{ text: 'x', start: 0, end: 0.5 }])
  assert.deepEqual(parseTimingsFile('[{"text":"x","start":"abc","end":1}]'), [], 'a non-numeric start is not a timing')
  assert.deepEqual(parseTimingsFile('[{"text":"","start":0,"end":1}]'), [], 'a timing with no text is not a word')
  assert.deepEqual(parseTimingsFile('not json'), [])
})

test('status reports one entry per provider with the default marked', () => {
  const config = normalizeConfig({ provider: 'edge' }, {})
  const statuses = providerStatuses(createProviders(config), config)
  assert.deepEqual(statuses.map((status) => status.id), ['edge', 'command'])
  assert.equal(statuses[0].isDefault, true)
  assert.equal(statuses[1].isDefault, false)
  assert.equal(statuses[0].requiresKey, false)
  assert.equal(statuses[0].requiresNetwork, true)
  assert.equal(statuses[1].requiresNetwork, false)
})
