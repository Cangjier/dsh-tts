/**
 * The dialogue action, driven by a fake engine.
 *
 * The offsets, the file names and the shared-voice report are the parts a real synthesis cannot
 * check cheaply: they need several lines, and they need the durations to be known in advance to
 * assert anything exact. A stub provider gives both, so the action is tested as a whole — including
 * the files it writes — without the network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../index.mjs'
import { createSpeakActions } from '../src/tools/actions.mjs'
import { readWordsFile } from '../src/core/output.mjs'

const quietLogger = { info() {}, warn() {}, error() {} }

/** One 0xff 0xfb frame header, enough for the output writer to accept the buffer. */
const FAKE_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22])

/**
 * Build a provider map whose `speak` returns canned durations and words.
 * @param {number[]} durations - one duration per call, in order.
 * @returns {Map<string, object>} the provider map.
 */
function fakeProviders(durations) {
  const queue = [...durations]
  const calls = []
  const provider = {
    id: 'edge',
    kind: 'network',
    requiresNetwork: false,
    timings: 'word-boundaries',
    defaults: { voice: 'zh-CN-XiaoxiaoNeural' },
    outputExtension: 'mp3',
    calls,
    async speak(request) {
      const duration = queue.shift() ?? 1
      calls.push({ text: request.text, voice: request.voice ?? null })
      return {
        audio: FAKE_MP3,
        words: [{ text: request.text.slice(0, 1), start: 0, end: duration }],
        duration,
        timings: 'word-boundaries',
        meta: { fake: true },
      }
    },
    async voices() {
      return { voices: [], total: 0 }
    },
    status: () => ({ id: 'edge', available: true, requiresNetwork: false, requiresKey: false, timings: 'word-boundaries', notes: [] }),
  }
  return new Map([
    ['edge', provider],
    ['command', provider],
  ])
}

const withTempDir = async (run) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tts-dialogue-action-'))
  try {
    await run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a dialogue lays its lines on the timeline and writes a manifest and a global sidecar', async () => {
  await withTempDir(async (directory) => {
    const providers = fakeProviders([2, 1])
    const actions = createSpeakActions(normalizeConfig({}, {}), quietLogger, { providers })
    const result = await actions.dialogue(
      {
        script: 'host-a: 第一句。\nhost-b: 第二句。',
        voices: { 'host-a': 'zh-CN-XiaoxiaoNeural', 'host-b': 'zh-CN-YunxiNeural' },
        outDir: directory,
        gapSeconds: 0.5,
        measure: false,
      },
      { cwd: directory },
    )

    assert.equal(result.lineCount, 2)
    assert.equal(result.provider, 'edge')
    assert.deepEqual(result.clips.map((clip) => [clip.at, clip.until]), [
      [0, 2.12],
      [2.5, 3.62],
    ])
    assert.equal(result.totalSeconds, 4.12)
    assert.deepEqual(result.sharedVoices, [])
    // measure:false means nothing was checked, which is reported as null rather than as success.
    assert.equal(result.verification.everyClipWithinItsFile, null)
    assert.deepEqual([result.verification.linesChecked, result.verification.linesUnchecked], [0, 2])

    // Every line has its own file, and the words are shifted onto the assembled clock.
    assert.equal(result.lines[0].audio.endsWith(join('lines', '001-host-a.mp3')), true)
    assert.equal(result.lines[1].audio.endsWith(join('lines', '002-host-b.mp3')), true)
    const { words } = readWordsFile(result.wordsPath)
    assert.deepEqual(words.map((word) => word.start), [0, 2.5])
    assert.deepEqual(words.map((word) => word.speaker), ['host-a', 'host-b'])

    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'))
    assert.equal(manifest.kind, 'dsh-tts/dialogue')
    assert.deepEqual(manifest.clips, result.clips)
    assert.deepEqual(manifest.lines.map((line) => line.voice), ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'])
    assert.deepEqual(manifest.voices, { 'host-a': 'zh-CN-XiaoxiaoNeural', 'host-b': 'zh-CN-YunxiNeural' })
    // Each line's own sidecar is written beside it, so a single line can be re-used on its own.
    assert.equal(result.lines[0].audio.replace(/\.mp3$/, '.words.json').endsWith('001-host-a.words.json'), true)
  })
})

test('two speakers on one voice are reported, and one speaker twice is not', async () => {
  await withTempDir(async (directory) => {
    // Three lines: host-a twice and host-b once, all on the same voice.
    const providers = fakeProviders([1, 1, 1])
    const actions = createSpeakActions(normalizeConfig({}, {}), quietLogger, { providers })
    const result = await actions.dialogue(
      {
        lines: [
          { speaker: 'host-a', text: '一。' },
          { speaker: 'host-b', text: '二。' },
          { speaker: 'host-a', text: '三。' },
        ],
        voice: 'zh-CN-XiaoxiaoNeural',
        outDir: directory,
        measure: false,
      },
      { cwd: directory },
    )
    assert.deepEqual(result.sharedVoices, [{ voice: 'zh-CN-XiaoxiaoNeural', speakers: ['host-a', 'host-b'] }])
  })
})

test('an outPath given to a dialogue cannot make every line overwrite the same file', async () => {
  await withTempDir(async (directory) => {
    const providers = fakeProviders([1, 1])
    const actions = createSpeakActions(normalizeConfig({}, {}), quietLogger, { providers })
    const result = await actions.dialogue(
      {
        script: 'A: 一。\nB: 二。',
        voices: { A: 'v1', B: 'v2' },
        outPath: 'ignored.mp3',
        outDir: directory,
        measure: false,
      },
      { cwd: directory },
    )
    const files = result.lines.map((line) => line.audio)
    assert.equal(new Set(files).size, 2, 'each line got its own file')
    assert.equal(files.every((file) => file.includes(`${join(directory, 'lines')}`)), true)
  })
})

test('a script whose prefix nobody declared is spoken by the first declared speaker, and reported', async () => {
  await withTempDir(async (directory) => {
    const providers = fakeProviders([1, 1])
    const actions = createSpeakActions(normalizeConfig({}, {}), quietLogger, { providers })
    const result = await actions.dialogue(
      {
        script: '开场白。\n时间：十点整。\nhost-b: 收到。',
        voices: { 'host-a': 'v1', 'host-b': 'v2' },
        outDir: directory,
        measure: false,
      },
      { cwd: directory },
    )
    assert.deepEqual(result.lines.map((line) => line.speaker), ['host-a', 'host-b'])
    assert.deepEqual(result.unknownSpeakerTokens, ['时间'])
    assert.match(providers.get('edge').calls[0].text, /开场白。时间：十点整。/)
  })
})
