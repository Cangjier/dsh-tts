/**
 * Paths and the sidecar contract.
 *
 * The sidecar is what makes this plugin usable by anything downstream, so its shape is pinned —
 * including the field that says where a duration came from, because a consumer that cannot tell a
 * measured length from a reported speech end will trim the wrong number of seconds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TtsError } from '../src/core/errors.mjs'
import { buildWordsDocument, readWordsFile, resolveAudioPath, resolveOutDir, wordsPathFor, writeSpeech } from '../src/core/output.mjs'

const cwd = process.platform === 'win32' ? 'C:\\work' : '/work'

test('the output directory comes from the call, then the config, then <cwd>/tts', () => {
  assert.equal(resolveOutDir({ outDir: null }, { outDir: 'narration' }, cwd), join(cwd, 'narration'))
  assert.equal(resolveOutDir({ outDir: 'out' }, {}, cwd), join(cwd, 'out'))
  assert.equal(resolveOutDir({}, {}, cwd), join(cwd, 'tts'))
})

test('the audio path follows the engine, so a WAV engine cannot write a file called .mp3', () => {
  assert.equal(resolveAudioPath({}, cwd, join(cwd, 'tts'), 'mp3'), join(cwd, 'tts', 'voiceover.mp3'))
  assert.equal(resolveAudioPath({ name: 'line-01' }, cwd, join(cwd, 'tts'), 'wav'), join(cwd, 'tts', 'line-01.wav'))
  assert.equal(resolveAudioPath({ outPath: 'deep/here.mp3' }, cwd, join(cwd, 'tts'), 'mp3'), join(cwd, 'deep', 'here.mp3'))
})

test('the sidecar sits beside the audio with the same stem', () => {
  assert.equal(wordsPathFor(join(cwd, 'a', 'voiceover.mp3')), join(cwd, 'a', 'voiceover.words.json'))
  assert.equal(wordsPathFor(join(cwd, 'plain')), join(cwd, 'plain.words.json'))
})

test('a duration that came from ffprobe reports no trailing silence, because nobody measured the speech end', () => {
  const measured = buildWordsDocument({
    audioPath: 'a.mp3',
    provider: 'command',
    words: [],
    durationSeconds: 3.5,
    durationSource: 'ffprobe',
    audioSeconds: 3.5,
    tailSilenceSeconds: null,
  })
  assert.equal(measured.tailSilenceSeconds, null)
  assert.equal(measured.durationSource, 'ffprobe')

  const reported = buildWordsDocument({
    audioPath: 'a.mp3',
    provider: 'edge',
    words: [{ text: '你好', start: 0.1, end: 0.7 }],
    durationSeconds: 0.7,
    durationSource: 'word-boundaries',
    audioSeconds: 1.575,
  })
  assert.equal(reported.tailSilenceSeconds, 0.875)
  assert.equal(reported.wordCount, 1)
  assert.deepEqual(reported.words, [{ text: '你好', start: 0.1, end: 0.7 }])
})

test('the sidecar round-trips through both shapes a reader may find', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tts-output-'))
  try {
    const audioPath = join(directory, 'voiceover.mp3')
    const document = buildWordsDocument({
      audioPath,
      provider: 'edge',
      voice: 'zh-CN-XiaoxiaoNeural',
      text: '你好',
      words: [{ text: '你', start: 0.12, end: 0.34 }],
      durationSeconds: 0.34,
      durationSource: 'word-boundaries',
      audioSeconds: 1.2,
      timings: 'word-boundaries',
    })
    const written = writeSpeech(audioPath, Buffer.from([0xff, 0xfb, 0x00, 0x00]), document)

    const fromDocument = readWordsFile(written.wordsPath)
    assert.equal(fromDocument.words.length, 1)
    assert.equal(fromDocument.duration, 0.34)

    // The bare-array shape video_narrate accepts is read just as well.
    const bare = join(directory, 'bare.words.json')
    writeSpeech(audioPath, Buffer.from([0xff, 0xfb]), [{ text: 'x', start: 0, end: 1 }], bare)
    assert.deepEqual(readWordsFile(bare).words, [{ text: 'x', start: 0, end: 1 }])
    assert.match(readFileSync(bare, 'utf8'), /^\s*\[/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('writing refuses to report success for an empty audio buffer', () => {
  assert.throws(() => writeSpeech('x.mp3', Buffer.alloc(0), {}), TtsError)
})
