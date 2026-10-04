/**
 * The live tests: a real synthesis against the read-aloud service.
 *
 * Skipped unless `DSH_TTS_LIVE=1`, because they need the network and they are the only tests here
 * that fail when a third party is down. Run them with:
 *
 *   DSH_TTS_LIVE=1 node --test tests/live.test.mjs
 *
 * What they are for: everything else in this suite is arithmetic. These two calls are the only
 * place where the plugin's claims about the service — that a key is not needed, that word
 * boundaries arrive, that the MP3 stream has no frame gaps — are checked against the service
 * itself rather than against a fixture.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../index.mjs'
import { createSetupActions, createSpeakActions } from '../src/tools/actions.mjs'
import { readWordsFile } from '../src/core/output.mjs'

const live = process.env.DSH_TTS_LIVE === '1'
const quietLogger = { info() {}, warn() {}, error() {} }

/**
 * Count how many 0d0a byte pairs sit between MPEG frames.
 *
 * This is the shape of the historical framing bug: the separator glued to the front of every audio
 * chunk, which lands a CRLF every 720 bytes. A healthy file may contain 0d0a inside frame payloads
 * by chance, so the check is kept out of the assertions and reported as a number instead — the
 * assertion that matters is that the decoded length is not 20% short, which `audioSeconds` gives.
 *
 * @param {Buffer} audio - the MP3 bytes.
 * @returns {number} the number of 0d0a pairs found.
 */
function crlfPairs(audio) {
  let count = 0
  for (let index = 0; index + 1 < audio.length; index += 1) {
    if (audio[index] === 0x0d && audio[index + 1] === 0x0a) count += 1
  }
  return count
}

test('edge synthesizes a sentence, returns word boundaries, and the file is not short', async (context) => {
  if (!live) {
    context.skip('需要网络与真实服务：设置 DSH_TTS_LIVE=1 后再跑。')
    return
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tts-live-'))
  try {
    const config = normalizeConfig({}, {})
    const actions = createSpeakActions(config, quietLogger)
    const result = await actions.speak(
      { text: '开源语音合成的选择很多，但带逐词时间戳的并不多。', outDir: directory, measure: true },
      { cwd: directory },
    )

    console.log('[live] speak:', JSON.stringify(result))
    assert.equal(result.provider, 'edge')
    assert.equal(result.timings, 'word-boundaries')
    assert.equal(result.wordCount > 0, true)
    assert.equal(result.bytes > 2000, true)
    assert.equal(result.durationSeconds > 0, true)
    assert.equal(result.durationSource, 'word-boundaries')

    const audio = readFileSync(result.audio)
    // The decoded file is at least as long as the last word that was spoken in it: if the CRLF
    // framing bug were back, the audio would be about 20% shorter than its own timings.
    assert.equal(result.audioSeconds === null || result.audioSeconds >= result.durationSeconds, true)
    // The trailing silence is a measured number, not a constant: it must exist (the service adds
    // one) and it must be small enough that the timings still describe the file.
    if (result.tailSilenceSeconds !== null) {
      assert.equal(result.tailSilenceSeconds > 0, true, 'the service appends some trailing silence')
      assert.equal(result.tailSilenceSeconds < 2, true, 'and it is not a whole second of nothing')
    }
    console.log(`[live] decoded ${result.audioSeconds}s, last word ended ${result.durationSeconds}s, tail ${result.tailSilenceSeconds}s, crlfPairs=${crlfPairs(audio)}`)

    const { words } = readWordsFile(result.wordsPath)
    assert.equal(words.length, result.wordCount)
    assert.equal(words[0].start >= 0, true)
    assert.equal(words[words.length - 1].end <= result.audioSeconds + 0.05, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('edge lists voices and the list contains the documented Mandarin ones', async (context) => {
  if (!live) {
    context.skip('需要网络与真实服务：设置 DSH_TTS_LIVE=1 后再跑。')
    return
  }
  const config = normalizeConfig({}, {})
  const actions = createSetupActions(config, quietLogger)

  let result
  try {
    result = await actions.voices({ locale: 'zh', limit: 200 }, { cwd: process.cwd() })
  } catch (error) {
    // This endpoint throttles bursts by resetting the connection (measured: one success in five
    // rapid attempts, recovering after about two minutes). That is a property of the network, not
    // of this plugin, so it is reported as an unmet precondition rather than as a regression — but
    // any other failure (401, a changed payload shape) still fails the test.
    if (/ECONNRESET|socket hang up|ETIMEDOUT/i.test(error?.message ?? '')) {
      context.skip(`音色端点正在限流（${error.message.split('。')[0]}）：这是网络条件，不是插件行为，等一分钟再跑。`)
      return
    }
    throw error
  }

  console.log(`[live] voices: total=${result.total} zh=${result.count} attempts=${result.attempts}`)
  assert.equal(result.provider, 'edge')
  assert.equal(result.count > 0, true)
  const names = result.voices.map((voice) => voice.shortName)
  assert.equal(names.includes('zh-CN-XiaoxiaoNeural'), true)
  assert.equal(names.every((name) => name.toLowerCase().startsWith('zh')), true)
})

test('a two-speaker dialogue becomes a timeline whose clips are inside the total', async (context) => {
  if (!live) {
    context.skip('需要网络与真实服务：设置 DSH_TTS_LIVE=1 后再跑。')
    return
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tts-live-dialogue-'))
  try {
    const config = normalizeConfig({}, {})
    const actions = createSpeakActions(config, quietLogger)
    const result = await actions.dialogue(
      {
        script: 'host-a: 欢迎收听。\nhost-b: 我们今天聊点什么？',
        voices: { 'host-a': 'zh-CN-XiaoxiaoNeural', 'host-b': 'zh-CN-YunxiNeural' },
        outDir: directory,
        measure: true,
      },
      { cwd: directory },
    )

    console.log('[live] dialogue:', JSON.stringify({ total: result.totalSeconds, lines: result.lines, shared: result.sharedVoices }))
    assert.equal(result.lineCount, 2)
    assert.equal(result.clips.length, 2)
    assert.equal(result.clips[0].at, 0)
    assert.equal(result.clips[1].at > result.clips[0].at, true)
    assert.equal(result.clips[1].at >= result.clips[0].until, true, 'lines do not overlap unless asked to')
    assert.equal(result.clips[result.clips.length - 1].until <= result.totalSeconds, true)
    assert.equal(result.wordCount > 0, true)
    assert.deepEqual(result.sharedVoices, [], 'two voices were asked for and two were used')
    // Both lines were measured at synthesis time, so every clip is checked against its own file.
    assert.equal(result.verification.linesChecked, 2)
    assert.equal(result.verification.everyClipWithinItsFile, true)
    assert.deepEqual(result.verification.violations, [])

    const { words } = readWordsFile(result.wordsPath)
    assert.equal(words.length, result.wordCount)
    assert.equal(words.some((word) => word.speaker === 'host-b'), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
