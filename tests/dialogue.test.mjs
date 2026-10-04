/**
 * Script parsing and timeline arithmetic.
 *
 * The offsets are the part of this plugin that cannot be checked by ear: a line that starts 300 ms
 * late is not obviously wrong in the audio, but every subtitle after it is. So the arithmetic is
 * pinned to the millisecond here, and the parser is pinned on the case that motivated the
 * allow-list — a colon inside an ordinary sentence must not invent a speaker.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TtsError } from '../src/core/errors.mjs'
import { dialogueDocument, parseScript, planTimeline, verifyClips } from '../src/core/dialogue.mjs'

test('a script becomes turns, and a line without a prefix continues the previous turn', () => {
  const parsed = parseScript(
    [
      '# 这是注释，不该出现在结果里',
      'host-a: 欢迎回来。',
      '今天聊聊语音合成，',
      '以及它为什么会跑偏。',
      'host-b: 好，那我们开始。',
    ].join('\n'),
    { speakers: ['host-a', 'host-b'] },
  )
  assert.deepEqual(parsed.turns, [
    { speaker: 'host-a', text: '欢迎回来。今天聊聊语音合成，以及它为什么会跑偏。', line: 2 },
    { speaker: 'host-b', text: '好，那我们开始。', line: 5 },
  ])
  assert.deepEqual(parsed.tokens, ['host-a', 'host-b'])
  assert.deepEqual(parsed.unknownTokens, [])
})

test('a colon inside a sentence does not invent a speaker when the cast is declared', () => {
  // The second line looks like a turn — "时间" is followed by a full-width colon — but nobody
  // declared a speaker called 时间, so it is text belonging to the turn above it.
  const parsed = parseScript('host-a: 开场。\n时间：十点整开始。\nhost-b: 收到。', { speakers: ['host-a', 'host-b'] })
  assert.equal(parsed.turns.length, 2)
  assert.equal(parsed.turns[0].text, '开场。时间：十点整开始。')
  // The unrecognised prefix is reported rather than silently swallowed or turned into a speaker.
  assert.deepEqual(parsed.unknownTokens, ['时间'])
  assert.equal(parsed.turns[0].speaker, 'host-a')
})

test('without a declared cast every well-formed prefix is a speaker, and text before one gets the default', () => {
  const parsed = parseScript('开场白。\nA: 第一句。\nB: 第二句。', { defaultSpeaker: 'narrator' })
  assert.deepEqual(parsed.turns.map((turn) => turn.speaker), ['narrator', 'A', 'B'])
  assert.deepEqual(parsed.tokens, ['A', 'B'])
})

test('a script with no speech at all is refused, not synthesized', () => {
  assert.throws(() => parseScript('# 只有注释\n\n// 还有这个'), /没有任何台词/)
  assert.throws(() => parseScript(''), TtsError)
})

test('the timeline places each line after the previous trimmed end, and shifts every word with it', () => {
  const plan = planTimeline(
    [
      { speaker: 'A', text: '第一句', audio: 'a.mp3', duration: 2, words: [{ text: '第', start: 0.1, end: 0.3 }] },
      { speaker: 'B', text: '第二句', audio: 'b.mp3', duration: 1, words: [{ text: '第', start: 0.2, end: 0.4 }] },
    ],
    { gapSeconds: 0.5, tailPadSeconds: 0.1, tailSeconds: 0.5 },
  )

  assert.deepEqual(plan.clips.map((clip) => ({ at: clip.at, until: clip.until, speaker: clip.speaker })), [
    { at: 0, until: 2.1, speaker: 'A' },
    { at: 2.5, until: 3.6, speaker: 'B' },
  ])
  // 0 + 2 + 0.5 = 2.5 for the second line; total = 2.5 + 1 + 0.5 (gap removed) + 0.1 + 0.5.
  assert.equal(plan.totalSeconds, 4.1)
  assert.deepEqual(plan.words, [
    { text: '第', start: 0.1, end: 0.3, speaker: 'A' },
    { text: '第', start: 2.7, end: 2.9, speaker: 'B' },
  ])
  assert.equal(plan.lines[1].chars, 3)
})

test('the clips are exactly the argument shape the assembler takes', () => {
  const plan = planTimeline([{ speaker: 'A', text: 'x', audio: 'a.mp3', duration: 1, words: [] }])
  const clip = plan.clips[0]
  assert.deepEqual(Object.keys(clip).sort(), ['at', 'duration', 'source', 'speaker', 'text', 'until'])
  assert.equal(clip.source, 'a.mp3')
})

test('a line with no usable duration stops the layout instead of guessing where the next one starts', () => {
  assert.throws(
    () => planTimeline([{ speaker: 'A', text: 'x', audio: 'a.mp3', duration: null, words: [] }]),
    /没有可用时长/,
  )
})

test('the manifest carries both halves of the job: clips for assembly and words for subtitles', () => {
  const entries = [{ speaker: 'A', text: '你好', audio: 'lines/001-A.mp3', duration: 1, words: [{ text: '你好', start: 0, end: 0.9 }], voice: 'v1' }]
  const plan = planTimeline(entries)
  const document = dialogueDocument({
    outDir: 'out',
    provider: 'edge',
    voices: { A: 'v1' },
    gapSeconds: 0.35,
    tailPadSeconds: 0.12,
    tailSeconds: 0.5,
    plan,
    entries,
    sharedVoices: [],
    unknownTokens: [],
    verification: verifyClips(plan.lines, [1.5]),
  })
  assert.equal(document.kind, 'dsh-tts/dialogue')
  assert.equal(document.lineCount, 1)
  assert.equal(document.clips.length, 1)
  assert.equal(document.words.length, 1)
  assert.equal(document.lines[0].voice, 'v1')
  assert.equal(document.words[0].speaker, 'A')
  assert.equal(document.verification.everyClipWithinItsFile, true)
})

test('a clip longer than its own file is reported, and an unmeasured one is not called true', () => {
  const plan = planTimeline([
    { speaker: 'A', text: 'x', audio: 'a.mp3', duration: 2, words: [] },
    { speaker: 'B', text: 'y', audio: 'b.mp3', duration: 1, words: [] },
  ])
  // The second line takes 1.12 s out of its file (until − at), so a 1 s file is too short for it —
  // even though the clip's absolute position (2.35 s) is later than that.
  const result = verifyClips(plan.lines, [2.5, 1])
  assert.equal(result.linesChecked, 2)
  assert.equal(result.everyClipWithinItsFile, false)
  assert.deepEqual(result.violations, [{ speaker: 'B', clipSeconds: 1.12, audioSeconds: 1 }])

  const inside = verifyClips(plan.lines, [2.5, 4])
  assert.equal(inside.everyClipWithinItsFile, true)
  assert.deepEqual(inside.violations, [])

  // measure:false and a missing ffprobe must not read as "verified".
  const unchecked = verifyClips(plan.lines, [null, null])
  assert.equal(unchecked.everyClipWithinItsFile, null)
  assert.equal(unchecked.linesUnchecked, 2)
})
