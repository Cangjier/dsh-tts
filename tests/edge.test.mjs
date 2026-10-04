/**
 * The Edge provider's pure parts: framing, escaping, signing, timestamps and metadata parsing.
 *
 * These are pinned here because each one has a failure mode that produces a plausible wrong result
 * rather than an error: a body offset that is two bytes off silently costs a fifth of the audio, an
 * unescaped ampersand silently drops text, and a signature computed for the wrong window is
 * rejected as if the service were down.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TtsError } from '../src/core/errors.mjs'
import {
  DEFAULT_VOICE,
  TRUSTED_CLIENT_TOKEN,
  audioBodyOffset,
  buildSsml,
  edgeTimestamp,
  escapeXml,
  lastWordEnd,
  parseVoiceList,
  parseWordBoundaries,
  secMsGec,
  voicesUrl,
} from '../src/core/providers/edge.mjs'

/** An MPEG-1 Layer III frame header, the sync word the body scan looks for. */
const SYNC = Buffer.from([0xff, 0xfb, 0x90, 0x00])

/** Build a `[2-byte headerLength][header][separator][audio]` message. */
function audioMessage({ headerLength, separator = '', audio = SYNC }) {
  const header = Buffer.from('Path:audio', 'latin1')
  const payload = Buffer.concat([Buffer.alloc(2), header, Buffer.from(separator, 'latin1'), audio])
  payload.writeUInt16BE(headerLength, 0)
  return payload
}

test('the audio body starts at the MPEG sync word, not at the declared header length', () => {
  // The framing that lost 20% of every file: the separator is NOT counted in headerLength.
  // header text is 10 bytes, the prefix is 2, the separator is 2 → the audio starts at 14.
  const withSeparator = audioMessage({ headerLength: 10, separator: '\r\n' })
  assert.equal(audioBodyOffset(withSeparator, 10), 14)
  assert.equal(withSeparator.subarray(14, 18).equals(SYNC), true)
  assert.equal(withSeparator.readUInt16BE(0), 10)
})

test('a declared length that already counts the separator lands on the same byte', () => {
  // Either framing is accepted, which is the point: the sync word decides, not the arithmetic.
  const counted = audioMessage({ headerLength: 12, separator: '\r\n' })
  assert.equal(audioBodyOffset(counted, 12), 14)
  const withoutSeparator = audioMessage({ headerLength: 10 })
  assert.equal(audioBodyOffset(withoutSeparator, 10), 12)
})

test('a body with no MPEG sync word falls back to the declared position', () => {
  const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
  const payload = audioMessage({ headerLength: 10, audio: pcm })
  assert.equal(audioBodyOffset(payload, 10), 12)
})

test('the sync scan does not run away past the declared length', () => {
  // A sync word far after the header must not be found: only ±16 bytes are considered.
  const payload = Buffer.concat([Buffer.alloc(64), SYNC])
  payload.writeUInt16BE(10, 0)
  assert.equal(audioBodyOffset(payload, 10), 12)
})

test('SSML escapes everything that would break the document', () => {
  const ssml = buildSsml('a < b & "c" \'d\'', 'zh-CN-XiaoxiaoNeural', '+10%', '-2Hz', '+0%')
  assert.equal(ssml.includes('a &lt; b &amp; &quot;c&quot; &apos;d&apos;'), true)
  assert.equal(ssml.includes("<voice name='zh-CN-XiaoxiaoNeural'>"), true)
  assert.equal(ssml.includes("rate='+10%'"), true)
  assert.equal(ssml.includes("pitch='-2Hz'"), true)
  assert.equal(escapeXml('<&>'), '&lt;&amp;&gt;')
})

test('Sec-MS-GEC is a 64-character uppercase hex digest that is stable inside its window', () => {
  // The signature is floored to a 300-second window of absolute time, so the window has to be
  // entered from its own start for this to be a test of stability rather than of arithmetic.
  const seconds = 1_760_000_000
  const windowStart = seconds - (seconds % 300)
  const base = windowStart * 1000
  const signature = secMsGec(base)
  assert.match(signature, /^[0-9A-F]{64}$/)
  assert.equal(secMsGec(base + 299_000), signature, 'the window is 300 seconds wide')
  assert.notEqual(secMsGec(base + 300_000), signature, 'a new window is a new signature')
})

test('the service timestamp reproduces the reference client format verbatim', () => {
  const stamp = edgeTimestamp(new Date(Date.UTC(2026, 9, 2, 13, 2, 46)))
  assert.equal(stamp, 'Fri Oct 02 2026 13:02:46 GMT+0000 (Coordinated Universal Time)')
})

test('word boundaries are read from Data.text.Text in ticks, and a broken frame costs timings only', () => {
  const body = Buffer.from(
    JSON.stringify({
      Metadata: [
        { Type: 'WordBoundary', Data: { Offset: 5_000_000, Duration: 2_000_000, text: { Text: '你好' } } },
        { Type: 'SentenceBoundary', Data: { Offset: 0, Duration: 0, text: { Text: 'ignored' } } },
        { Type: 'WordBoundary', Data: { Offset: 7_000_000, Duration: 1_000_000, text: { Text: '世界' } } },
        { Type: 'WordBoundary', Data: { Offset: 'x', Duration: 1, text: { Text: 'bad' } } },
      ],
    }),
    'utf8',
  )
  const words = parseWordBoundaries(body)
  assert.deepEqual(words, [
    { text: '你好', start: 0.5, end: 0.7 },
    { text: '世界', start: 0.7, end: 0.8 },
  ])
  assert.deepEqual(parseWordBoundaries(Buffer.from('not json')), [])
  assert.equal(lastWordEnd(words), 0.8)
  assert.equal(lastWordEnd([]), 0)
})

test('the voice list is normalized defensively and refuses a shape it cannot read', () => {
  const payload = JSON.stringify([
    {
      Name: 'Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)',
      ShortName: 'zh-CN-XiaoxiaoNeural',
      Gender: 'Female',
      Locale: 'zh-CN',
      FriendlyName: 'Xiaoxiao',
      VoiceTag: { ContentCategories: ['News'], VoicePersonalities: ['Warm'] },
      Status: 'GA',
    },
    // An entry with no ShortName is dropped rather than returned as an empty voice.
    { Name: 'broken' },
  ])
  const voices = parseVoiceList(payload)
  assert.equal(voices.length, 1)
  assert.deepEqual(voices[0], {
    shortName: 'zh-CN-XiaoxiaoNeural',
    locale: 'zh-CN',
    gender: 'Female',
    friendlyName: 'Xiaoxiao',
    personalities: ['Warm'],
    categories: ['News'],
    status: 'GA',
  })
  // Older responses carried neither VoiceTag nor Status; the fields default instead of vanishing.
  assert.deepEqual(parseVoiceList(JSON.stringify([{ ShortName: 'a', Locale: 'en-US' }]))[0].personalities, [])
  assert.throws(() => parseVoiceList('{"voices":[]}'), TtsError)
  assert.throws(() => parseVoiceList('not json'), TtsError)
})

test('the voice list URL carries the public token and the default voice is the documented one', () => {
  assert.equal(voicesUrl(), `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`)
  assert.equal(DEFAULT_VOICE, 'zh-CN-XiaoxiaoNeural')
})
