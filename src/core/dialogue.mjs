/**
 * Turning a written conversation into a timeline.
 *
 * WHY THIS IS PURE ARITHMETIC AND NOT A MIXER
 * -------------------------------------------
 * A podcast is several utterances in different voices laid end to end. This module does the part
 * that must be exact and can be tested without a sound card: who speaks, in what order, where each
 * line starts, and when every word of it is spoken on the assembled clock. It writes no audio — the
 * clips it returns are the input to sample-exact assembly, which already exists in the sibling
 * `audio_build {action:"assemble"}` action.
 *
 * The word timings are the reason this is worth doing here rather than by hand: each line's own
 * words are shifted by that line's start offset, so one global sidecar describes the whole
 * conversation and can be handed straight to a subtitle step.
 *
 * WHAT A DURATION IS WORTH
 * ------------------------
 * Every offset depends on knowing how long a line is. A provider that reports it (edge: the end of
 * the last word) is exact; a provider that does not is measured with ffprobe; a provider that
 * gives neither makes the timeline impossible, and this module refuses rather than guessing —
 * {@link planTimeline} reports which lines had no duration instead of silently collapsing them.
 *
 * @module dsh-tts/core/dialogue
 */
import { TtsError } from './errors.mjs'

/**
 * A speaker prefix at the start of a line: a short token followed by a colon.
 *
 * Both `:` and the full-width `：` are accepted because a Chinese script is usually written with
 * the latter, and the token is restricted to letters, digits, spaces, dots, hyphens and
 * underscores so that an ordinary sentence containing a colon is not mistaken for a speaker.
 */
const TURN_PREFIX = /^\s*([\p{L}\p{N}][\p{L}\p{N} _.-]{0,23})\s*[:：]\s*(.*)$/u

/** Lines starting with these are comments and are dropped. */
const COMMENT_PREFIXES = ['#', '//']

/**
 * Parse a dialogue script into turns.
 *
 * Format: one turn per line, `speaker: text`; a line without a recognised prefix continues the
 * previous turn, which is how a long speech is written across several lines. Blank lines and
 * `#` / `//` comments are ignored.
 *
 * `speakers` is the allow-list. When it is given, a prefix that is not in it is treated as part of
 * the text and reported in `unknownTokens` — this is what stops `时间：十点` from inventing a
 * speaker called `时间`. When it is omitted, every well-formed prefix is taken as a speaker.
 *
 * @param {string} script - the script text.
 * @param {object} [options] - parse options.
 * @param {string[]} [options.speakers] - the speakers the caller declared, if any.
 * @param {string} [options.defaultSpeaker] - speaker for text before any prefix; defaults to the first declared speaker.
 * @returns {{turns: {speaker: string, text: string, line: number}[], tokens: string[], unknownTokens: string[], charCount: number}}
 *   the turns in script order, every prefix seen, the prefixes that were not recognised, and how
 *   many characters of speech there are.
 * @throws {TtsError} when the script has no speech in it.
 */
export function parseScript(script, options = {}) {
  const text = typeof script === 'string' ? script : ''
  const known = Array.isArray(options.speakers) ? options.speakers.filter((name) => typeof name === 'string' && name !== '') : []
  const defaultSpeaker = typeof options.defaultSpeaker === 'string' && options.defaultSpeaker !== '' ? options.defaultSpeaker : (known[0] ?? 'speaker')

  const turns = []
  const tokens = []
  const unknownTokens = []
  let current = null

  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim() === '') continue
    if (COMMENT_PREFIXES.some((prefix) => raw.trimStart().startsWith(prefix))) continue

    const match = TURN_PREFIX.exec(raw)
    const token = match === null ? null : match[1].trim()
    const isTurn = match !== null && (known.length === 0 || known.includes(token))

    if (isTurn) {
      if (!tokens.includes(token)) tokens.push(token)
      current = { speaker: token, text: match[2].trim(), line: index + 1 }
      turns.push(current)
      continue
    }

    if (match !== null && token !== null && !tokens.includes(token) && !unknownTokens.includes(token)) {
      unknownTokens.push(token)
    }

    if (current === null) {
      current = { speaker: defaultSpeaker, text: raw.trim(), line: index + 1 }
      turns.push(current)
      continue
    }
    // A continuation line: CJK text is joined without a space, Latin text with one, which is what
    // a writer means either way.
    const previous = current.text
    const joiner = /[\u3000-\u9fff\uff00-\uffef]$/.test(previous) || /^[\u3000-\u9fff\uff00-\uffef]/.test(raw.trim()) ? '' : ' '
    current.text = `${previous}${joiner}${raw.trim()}`
  }

  const speechTurns = turns.filter((turn) => turn.text !== '')
  const charCount = speechTurns.reduce((total, turn) => total + turn.text.length, 0)
  if (speechTurns.length === 0) {
    throw new TtsError('脚本里没有任何台词：每行写成 "说话人: 台词"，或者直接给一段纯文本。')
  }
  return { turns: speechTurns, tokens, unknownTokens, charCount }
}

/**
 * Lay utterances on one timeline.
 *
 * Each line starts `gapSeconds` after the previous one *ends* — where "ends" is the trimmed end
 * `until`, not the raw file length, because every engine appends a little silence and a podcast
 * that keeps it sounds like a series of long pauses.
 *
 * @param {{speaker: string, text: string, audio: string, duration: number, words: object[], source?: string}[]} entries -
 *   one entry per synthesized line, in speaking order.
 * @param {object} [options] - layout options.
 * @param {number} [options.gapSeconds] - silence between lines; defaults to 0.35.
 * @param {number} [options.tailPadSeconds] - extra seconds kept after the last word; defaults to 0.12.
 * @param {number} [options.tailSeconds] - room after the last line; defaults to 0.5.
 * @returns {{clips: object[], words: object[], totalSeconds: number, lines: object[]}} the timeline.
 * @throws {TtsError} when an entry has no usable duration.
 */
export function planTimeline(entries, options = {}) {
  const gapSeconds = typeof options.gapSeconds === 'number' && options.gapSeconds >= 0 ? options.gapSeconds : 0.35
  const tailPadSeconds = typeof options.tailPadSeconds === 'number' && options.tailPadSeconds >= 0 ? options.tailPadSeconds : 0.12
  const tailSeconds = typeof options.tailSeconds === 'number' && options.tailSeconds >= 0 ? options.tailSeconds : 0.5

  const list = Array.isArray(entries) ? entries : []
  const missing = list.filter((entry) => !Number.isFinite(entry?.duration) || entry.duration <= 0)
  if (missing.length > 0) {
    throw new TtsError(
      `无法排版：第 ${missing.map((entry) => list.indexOf(entry) + 1).join(', ')} 行没有可用时长。` +
        'edge 会报最后一个词的结束时刻；本地引擎需要 ffprobe 在 PATH（或 vendor）里才能量出时长——装好 ffprobe 再试。',
    )
  }

  const round = (value) => Number(value.toFixed(3))
  const clips = []
  const words = []
  const lines = []
  let cursor = 0

  for (const entry of list) {
    const at = cursor
    const until = round(at + entry.duration + tailPadSeconds)
    clips.push({
      source: entry.source ?? entry.audio,
      at: round(at),
      until,
      speaker: entry.speaker,
      text: entry.text,
      duration: round(entry.duration),
    })
    for (const word of entry.words ?? []) {
      words.push({ text: word.text, start: round(at + word.start), end: round(at + word.end), speaker: entry.speaker })
    }
    lines.push({ speaker: entry.speaker, audio: entry.audio, at: round(at), duration: round(entry.duration), until, chars: entry.text.length })
    cursor += entry.duration + gapSeconds
  }

  const totalSeconds = list.length === 0 ? 0 : round(cursor - gapSeconds + tailPadSeconds + tailSeconds)
  return { clips, words, totalSeconds, lines }
}

/**
 * The manifest a dialogue call leaves on disk.
 *
 * It carries both halves of the job: `clips` is exactly the argument `audio_build {action:"assemble"}`
 * takes, and `words` is exactly what a subtitle step reads. Nothing in it is derived from anything
 * else at read time, so the manifest is reproducible evidence of what was requested.
 *
 * @param {object} input - the parts.
 * @returns {object} the manifest document.
 */
export function dialogueDocument(input) {
  const {
    outDir = null,
    provider,
    voices = {},
    gapSeconds,
    tailPadSeconds,
    tailSeconds,
    plan,
    entries = [],
    sharedVoices = [],
    unknownTokens = [],
    verification = null,
  } = input
  return {
    kind: 'dsh-tts/dialogue',
    outDir,
    provider,
    voices,
    gapSeconds,
    tailPadSeconds,
    tailSeconds,
    totalSeconds: plan.totalSeconds,
    lineCount: plan.lines.length,
    sharedVoices,
    unknownSpeakerTokens: unknownTokens,
    ...(verification === null ? {} : { verification }),
    clips: plan.clips,
    lines: plan.lines.map((line, index) => ({
      ...line,
      voice: entries[index]?.voice ?? null,
      words: (entries[index]?.words ?? []).length,
    })),
    words: plan.words,
  }
}

/**
 * Check every clip against the file it points at.
 *
 * This is the check the timeline itself cannot make: `until` was computed from the duration the
 * engine reported, and if the file on disk is shorter than that (the signature of a truncated
 * download, the historical frame-gap bug, or an engine that reported optimistically) then every
 * clip after it is built on a lie. Each line was measured at synthesis time, so the comparison is
 * free here — the only reason it is a separate function is that it must stay honest when nothing
 * was measured, which is what the three-valued result is for.
 *
 * The comparison is between the clip's **own length** and its file, not between `until` and the
 * file: `until` is a position on the assembled timeline, while each line's file starts at zero. A
 * second line that begins at 2.35 s of a 1.3 s file is perfectly fine; a 1.3 s clip cut out of a
 * 1.0 s file is not.
 *
 * @param {object[]} lines - the planned lines, each with `at` and `until`.
 * @param {Array<number|null>} audioSeconds - the decoded length of each line's file, in the same order.
 * @param {number} [tolerance] - seconds of slack allowed; defaults to 0.05.
 * @returns {{linesChecked: number, linesUnchecked: number, everyClipWithinItsFile: boolean|null, violations: object[], note: string}}
 *   `everyClipWithinItsFile` is null when nothing could be checked — not true, because nothing was
 *   verified, and not false, because nothing was found wrong.
 */
export function verifyClips(lines, audioSeconds, tolerance = 0.05) {
  const checked = []
  for (let index = 0; index < lines.length; index += 1) {
    const measured = audioSeconds[index]
    if (typeof measured === 'number' && measured > 0) checked.push({ line: lines[index], audioSeconds: measured })
  }
  const violations = checked
    .filter((item) => item.line.until - item.line.at > item.audioSeconds + tolerance)
    .map((item) => ({
      speaker: item.line.speaker,
      clipSeconds: Number((item.line.until - item.line.at).toFixed(3)),
      audioSeconds: Number(item.audioSeconds.toFixed(3)),
    }))

  return {
    linesChecked: checked.length,
    linesUnchecked: lines.length - checked.length,
    everyClipWithinItsFile: checked.length === 0 ? null : violations.length === 0,
    violations,
    note:
      '每行要截取的片段长度（until − at）必须落在该行文件之内。everyClipWithinItsFile 为 null 表示' +
      '没有一行被量过（measure:false 或没有 ffprobe），而不是"都没问题"。',
  }
}
