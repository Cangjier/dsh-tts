/**
 * The `edge` provider: narration through Microsoft Edge's read-aloud service.
 *
 * No API key is needed, the Mandarin voices are good, and — critically for anything that has to
 * put subtitles on the result — the service reports a boundary for every spoken word. One call
 * therefore yields both the audio and the times at which it is spoken.
 *
 * The service is reached over a hand-rolled WebSocket ({@link module:dsh-tts/core/ws}) because it
 * demands an `Origin` header and a `Cookie`, which Node's global `WebSocket` cannot set. The
 * signature travels in the query string, not a header: `Sec-MS-GEC` is the SHA-256 of the current
 * 100-nanosecond tick count (floored to a 300-second window) prefixed onto the trusted client
 * token, hex-encoded uppercase.
 *
 * ⚠️ Licensing: Microsoft has not documented a right to redistribute read-aloud output
 * commercially. Use it for drafts and personal content, and switch to Azure AI Speech (or another
 * licensed engine) for anything sold. This is a fact about the service, not a limitation of the
 * provider interface: `command` exists precisely so the engine can be swapped.
 *
 * @module dsh-tts/core/providers/edge
 */
import crypto from 'node:crypto'
import { TtsError } from '../errors.mjs'
import { connect } from '../ws.mjs'
import { httpsGetText } from '../proxy.mjs'

/** Stable provider id, as it appears in `config.provider`. */
export const PROVIDER_ID = 'edge'

/** The read-aloud endpoint, minus its query string. */
const SPEECH_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'

/** The voice list endpoint, minus its query string. */
const VOICES_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list'

/** The public trusted client token every read-aloud client ships with. */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

/** The Edge build this client imitates; its major version must match the User-Agent. */
const GEC_VERSION = '143.0.3650.75'

/** Major version of {@link GEC_VERSION}, kept in step with `Sec-MS-GEC-Version`. */
const GEC_MAJOR = GEC_VERSION.split('.')[0]

/** The extension origin the service expects from the Edge read-aloud extension. */
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'

/** Audio format requested from the service; 24 kHz mono MP3. */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** Edge reports boundary offsets and durations in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000

/** Seconds between the Windows file-time epoch (1601) and the Unix epoch (1970). */
const WINDOWS_EPOCH_OFFSET_SECONDS = 11644473600

/** `Sec-MS-GEC` is constant within this window; the service rejects older signatures. */
const GEC_WINDOW_SECONDS = 300

/** Default voice: a natural mainland-Mandarin female voice. */
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/** Default handshake and synthesis timeout. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Default timeout for the voice-list request. */
const DEFAULT_VOICES_TIMEOUT_MS = 20_000

/**
 * How many times the voice list is attempted.
 *
 * Two, and deliberately not more. The endpoint throttles bursts — measured on the development
 * machine: one request succeeded, the next four were reset, and after about two minutes of quiet it
 * answered again. A retry loop measured in seconds cannot cross a cooldown of that length, so a
 * third attempt would only add latency and another request to whatever counter is being kept. The
 * second attempt exists for an ordinary TCP blip; anything more is the caller's decision, taken a
 * minute later.
 */
const DEFAULT_VOICES_ATTEMPTS = 2

/** Milliseconds to wait before the second attempt. */
const DEFAULT_VOICES_RETRY_DELAY_MS = 1500

/** The steps this provider applies when the caller states nothing. */
export const EDGE_DEFAULTS = {
  voice: DEFAULT_VOICE,
  rate: '+0%',
  pitch: '+0Hz',
  volume: '+0%',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  outputFormat: OUTPUT_FORMAT,
}

/**
 * Compute the `Sec-MS-GEC` signature for a given instant.
 *
 * The tick count is floored to a 300-second window and then concatenated with seven
 * zero digits — that is the 100-nanosecond-subsecond part of the file time, not a
 * numeric multiplication, and getting it wrong is rejected as a bad signature.
 *
 * The instant is a parameter so the signature can be pinned in a test: on the wire it is always
 * `Date.now()`.
 *
 * @param {number} [nowMs] - the instant in Unix milliseconds; defaults to now.
 * @returns {string} the uppercase hex SHA-256 the service expects.
 */
export function secMsGec(nowMs = Date.now()) {
  let ticks = Math.floor(nowMs / 1000 + WINDOWS_EPOCH_OFFSET_SECONDS)
  ticks -= ticks % GEC_WINDOW_SECONDS
  return crypto
    .createHash('sha256')
    .update(`${ticks}0000000${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase()
}

/** Weekday and month names, as the service's timestamp format spells them. */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Format a time the way the service's own client does.
 *
 * The literal `GMT+0000 (Coordinated Universal Time)` suffix is a quirk of the
 * reference client and is reproduced verbatim; the value itself is UTC.
 *
 * @param {Date} [now] - the instant to format.
 * @returns {string} for example `Wed Oct 02 2026 13:02:46 GMT+0000 (Coordinated Universal Time)`.
 */
export function edgeTimestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${DAY_NAMES[now.getUTCDay()]} ${MONTH_NAMES[now.getUTCMonth()]} ${pad(now.getUTCDate())} ${now.getUTCFullYear()} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  )
}

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }

/**
 * Escape text for inclusion in XML character data.
 * @param {string} text - raw text.
 * @returns {string} the escaped text.
 */
export function escapeXml(text) {
  return text.replace(/[<>&'"]/g, (character) => XML_ESCAPES[character])
}

/**
 * Build the SSML document for one request.
 * @param {string} text - already stripped narration text.
 * @param {string} voice - voice short name.
 * @param {string} rate - rate adjustment, such as `+10%`.
 * @param {string} pitch - pitch adjustment, such as `-2Hz`.
 * @param {string} volume - volume adjustment, such as `+0%`.
 * @returns {string} the SSML to send.
 */
export function buildSsml(text, voice, rate, pitch, volume) {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody pitch='${escapeXml(pitch)}' rate='${escapeXml(rate)}' volume='${escapeXml(volume)}'>` +
    `${escapeXml(text)}` +
    '</prosody></voice></speak>'
  )
}

/** One 32-hex-digit identifier, the form the service uses for connection and request ids. */
const randomId = () => crypto.randomUUID().replace(/-/g, '')

/**
 * Round a number of seconds to the millisecond.
 *
 * The service reports 100-nanosecond ticks, and the division lands on values like
 * `0.7999999999999999`. Timings are consumed as seconds by everything downstream, so the noise is
 * removed where the conversion happens rather than in each consumer.
 *
 * @param {number} value - seconds.
 * @returns {number} the same instant, to three decimals.
 */
const round3 = (value) => Number(value.toFixed(3))

/**
 * Split a header-prefixed payload into a lowercase header map plus body.
 * @param {Buffer} buffer - the frame payload.
 * @param {number} headerLength - byte length of the header block.
 * @returns {{headers: Map<string,string>, body: Buffer}} the parsed parts.
 */
function splitHeaders(buffer, headerLength) {
  const headers = new Map()
  for (const line of buffer.subarray(0, headerLength).toString('latin1').split('\r\n')) {
    const index = line.indexOf(':')
    if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim())
  }
  return { headers, body: buffer.subarray(headerLength) }
}

/**
 * Work out where the MP3 bytes start inside one binary `Path:audio` message.
 *
 * The message is `[2-byte headerLength][header text][audio]`, where `headerLength` counts the
 * header text but not the two length bytes — that is the framing the reference client parses. The
 * header text may or may not be followed by a CRLF that `headerLength` does or does not count, and
 * that has not been stable: when the separator is left out of the count, slicing at the declared
 * length leaves the two separator bytes glued to the front of every chunk. Five frames later the
 * next chunk adds two more, so the file gains a CRLF every 720 bytes and a decoder drops one frame
 * per gap — twenty percent of the audio, silently, and the track ends up shorter than its own word
 * timings.
 *
 * The fix is not "+2", which would break again the next time the framing moves: the body is found
 * where the MPEG sync word actually is, allowing either side of the declared position. A payload
 * without an MPEG sync word falls back to the declared position, which is correct for a body that
 * carries no separator.
 *
 * @param {Buffer} payload - the whole binary message, length bytes included.
 * @param {number} headerLength - the length the message declares for its header text.
 * @returns {number} the absolute offset of the first audio byte.
 */
export function audioBodyOffset(payload, headerLength) {
  const declared = 2 + headerLength
  const from = Math.max(2, declared - 4)
  const to = Math.min(payload.length - 1, declared + 16)
  for (let at = from; at < to; at += 1) {
    // An MPEG audio frame header: eleven set bits, then a version and a layer that exist.
    if (payload[at] !== 0xff || (payload[at + 1] & 0xe0) !== 0xe0) continue
    const version = (payload[at + 1] >> 3) & 3
    const layer = (payload[at + 1] >> 1) & 3
    if (version === 1 || layer === 0) continue
    return at
  }
  return declared
}

/**
 * Read the word boundaries out of one `audio.metadata` body.
 *
 * The shape is not the obvious one: `Data.text` is itself an object and the spoken
 * text lives at `Data.text.Text`. `Offset` and `Duration` are 100-nanosecond ticks.
 *
 * @param {Buffer} body - the JSON body of the metadata frame.
 * @returns {{text: string, start: number, end: number}[]} the words found, in spoken order.
 */
export function parseWordBoundaries(body) {
  const words = []
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return words // a metadata frame we cannot read costs timings, not the audio
  }
  for (const item of parsed?.Metadata ?? []) {
    if (item?.Type !== 'WordBoundary') continue
    const data = item.Data ?? {}
    const text = data.text?.Text
    if (typeof text !== 'string' || text === '') continue
    const start = round3(Number(data.Offset) / TICKS_PER_SECOND)
    const end = round3(start + Number(data.Duration) / TICKS_PER_SECOND)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    words.push({ text, start, end })
  }
  return words
}

/**
 * The end of the last word, which is the duration this provider reports.
 *
 * It is deliberately not the MP3's own length: the service appends about 0.875 s of silence to
 * every utterance, and a caller laying out a timeline wants to know when the words stopped. The
 * difference between the two is measured by `tts_setup {action:"check"}` as `tailSilenceSeconds`.
 *
 * @param {{start: number, end: number}[]} words - the word timings.
 * @returns {number} seconds, or 0 when there are no words.
 */
export function lastWordEnd(words) {
  return words.length > 0 ? words[words.length - 1].end : 0
}

/**
 * Normalize the voice-list payload into this plugin's shape.
 *
 * Every field is copied defensively: the service has changed which optional fields it sends
 * (`VoiceTag` and `Status` were not in older responses), and a missing field must not turn into
 * `undefined` in a tool result.
 *
 * @param {string|object} payload - the response body, as text or already parsed.
 * @returns {{shortName: string, locale: string, gender: string|null, friendlyName: string|null, personalities: string[], categories: string[], status: string|null}[]}
 *   the voices, in the order the service listed them.
 * @throws {TtsError} when the payload is not a JSON array of voices.
 */
export function parseVoiceList(payload) {
  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload)
    } catch (error) {
      throw new TtsError(`edge 音色列表不是 JSON：${error.message}`)
    }
  }
  if (!Array.isArray(parsed)) {
    throw new TtsError('edge 音色列表的顶层不是数组，服务返回的结构变了')
  }
  return parsed
    .map((entry) => {
      const shortName = typeof entry?.ShortName === 'string' ? entry.ShortName : ''
      if (shortName === '') return null
      const tag = entry?.VoiceTag ?? {}
      return {
        shortName,
        locale: typeof entry?.Locale === 'string' ? entry.Locale : '',
        gender: typeof entry?.Gender === 'string' ? entry.Gender : null,
        friendlyName: typeof entry?.FriendlyName === 'string' ? entry.FriendlyName : null,
        personalities: Array.isArray(tag?.VoicePersonalities) ? [...tag.VoicePersonalities] : [],
        categories: Array.isArray(tag?.ContentCategories) ? [...tag.ContentCategories] : [],
        status: typeof entry?.Status === 'string' ? entry.Status : null,
      }
    })
    .filter((voice) => voice !== null)
}

/**
 * The voice-list URL, including the public token the endpoint requires.
 * @returns {string} the absolute URL.
 */
export function voicesUrl() {
  return `${VOICES_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`
}

/**
 * Synthesize one utterance and return the audio plus per-word timings.
 *
 * One connection produces the whole utterance: `speech.config` asks for word boundaries and MP3,
 * the SSML asks for the voice and prosody, binary frames carry the audio, and `turn.end` closes
 * the exchange.
 *
 * @param {object} input - the synthesis request.
 * @param {string} input.text - narration text; required and must not be blank.
 * @param {string} [input.voice] - voice short name; defaults to {@link DEFAULT_VOICE}.
 * @param {string} [input.rate] - rate adjustment; defaults to `+0%`.
 * @param {string} [input.pitch] - pitch adjustment; defaults to `+0Hz`.
 * @param {string} [input.volume] - volume adjustment; defaults to `+0%`.
 * @param {number} [input.timeoutMs] - give up after this long; defaults to 60000.
 * @returns {Promise<{audio: Buffer, words: {text: string, start: number, end: number}[], duration: number, timings: string, meta: object}>}
 *   the MP3 bytes, the word timings in seconds, the end of the last word, and what was requested.
 * @throws {TtsError} when the text is empty, the service fails, the wait times out, or no audio arrives.
 */
export async function speak(input) {
  const {
    text,
    voice = DEFAULT_VOICE,
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = input ?? {}

  if (typeof text !== 'string' || text.trim() === '') {
    throw new TtsError('edge: 文本为空，无法合成语音')
  }
  const narration = text.trim()

  const url =
    `${SPEECH_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${randomId()}` +
    `&Sec-MS-GEC=${secMsGec()}` +
    `&Sec-MS-GEC-Version=1-${GEC_VERSION}`

  const headers = {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: ORIGIN,
    'User-Agent':
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${GEC_MAJOR}.0.0.0 Safari/537.36 Edg/${GEC_MAJOR}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
  }

  const socket = connect({ url, headers, timeoutMs })
  const chunks = []
  const words = []

  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const settle = (error, value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }

      timer = setTimeout(() => settle(new TtsError(`edge: 合成超时（${timeoutMs}ms）`)), timeoutMs)

      socket.on('error', (error) => settle(new TtsError(`edge: 连接失败：${error?.message || error?.code || '未知错误'}`)))

      socket.on('close', () => settle(new TtsError('edge: 在 turn.end 之前关闭了连接')))

      socket.on('open', () => {
        socket.send(
          `X-Timestamp:${edgeTimestamp()}\r\n` +
            'Content-Type:application/json; charset=utf-8\r\n' +
            'Path:speech.config\r\n\r\n' +
            '{"context":{"synthesis":{"audio":{"metadataoptions":' +
            '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
            `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
        )
        socket.send(
          `X-RequestId:${randomId()}\r\n` +
            'Content-Type:application/ssml+xml\r\n' +
            `X-Timestamp:${edgeTimestamp()}Z\r\n` +
            'Path:ssml\r\n\r\n' +
            buildSsml(narration, voice, rate, pitch, volume),
        )
      })

      socket.on('text', (payload) => {
        const end = payload.indexOf('\r\n\r\n')
        if (end < 0) return
        const { headers: frameHeaders, body } = splitHeaders(payload, end)
        const path = frameHeaders.get('path')

        if (path === 'turn.end') {
          if (chunks.length === 0) {
            settle(new TtsError('edge: 未返回任何音频数据'))
            return
          }
          const audio = Buffer.concat(chunks)
          settle(null, {
            audio,
            words,
            duration: lastWordEnd(words),
            timings: 'word-boundaries',
            meta: { voice, rate, pitch, volume, outputFormat: OUTPUT_FORMAT, endpoint: 'readaloud/edge/v1' },
          })
          return
        }
        // `audio.metadata` carries the word boundaries; `turn.start` and `response`
        // carry nothing this plugin needs.
        if (path !== 'audio.metadata') return
        words.push(...parseWordBoundaries(body))
      })

      socket.on('binary', (payload) => {
        if (payload.length < 2) return
        // The first two bytes are a big-endian header length for the header text that follows; the
        // header is parsed from after those bytes, and the audio body is located by the frame sync
        // word rather than by trusting the declared length: see {@link audioBodyOffset}.
        const headerLength = payload.readUInt16BE(0)
        if (headerLength > payload.length) return
        const { headers: frameHeaders } = splitHeaders(payload.subarray(2), headerLength)
        if (frameHeaders.get('path') !== 'audio') return
        const body = payload.subarray(audioBodyOffset(payload, headerLength))
        if (body.length > 0) chunks.push(body)
      })
    })
  } finally {
    socket.destroy()
  }
}

/**
 * Fetch the voices the service currently offers.
 *
 * This is a network call and the list changes server-side, so it is reported as what the service
 * said at that moment — never cached into a constant that would silently go stale.
 *
 * THROTTLING, MEASURED RATHER THAN GUESSED
 * ----------------------------------------
 * Repeated requests to this endpoint are reset (`ECONNRESET`) — on the development machine, one
 * request in a burst of five succeeded and the rest were reset, and after roughly two minutes of
 * quiet it answered again. Retrying within seconds therefore cannot help, which is why there are
 * two attempts and not ten: the second covers an ordinary transport blip, and the error message
 * tells the caller to come back in a minute instead of looping. A synthesis is never retried at all:
 * a second attempt costs the caller another second and may legitimately produce different audio.
 *
 * @param {object} [options] - request options.
 * @param {number} [options.timeoutMs] - request timeout; defaults to 20000.
 * @param {string} [options.locale] - keep only voices whose locale starts with this, e.g. `zh`.
 * @param {number} [options.attempts] - how many times to try; defaults to 2.
 * @param {number} [options.retryDelayMs] - delay before the second attempt; defaults to 1500.
 * @returns {Promise<{voices: object[], total: number, url: string, attempts: number}>} the voices and how many arrived.
 * @throws {TtsError} when every attempt fails or the payload cannot be read.
 */
export async function voices(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VOICES_TIMEOUT_MS
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : DEFAULT_VOICES_ATTEMPTS
  const retryDelayMs = typeof options.retryDelayMs === 'number' && options.retryDelayMs >= 0 ? options.retryDelayMs : DEFAULT_VOICES_RETRY_DELAY_MS
  let payload = null
  let used = 0
  const failures = []

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    used = attempt
    try {
      payload = await httpsGetText(voicesUrl(), { timeoutMs })
      break
    } catch (error) {
      failures.push(error?.message ?? String(error))
      if (attempt < attempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }
  if (payload === null) {
    throw new TtsError(
      `edge: 取音色列表失败（试了 ${attempts} 次）：${failures[failures.length - 1] ?? '未知错误'}。` +
        '该端点会重置短时间内的密集请求（实测：连发 5 次只成功 1 次，安静约两分钟后恢复），' +
        '所以不要在几秒内重试——等一分钟再调用一次。',
    )
  }

  const all = parseVoiceList(payload.text)
  const locale = typeof options.locale === 'string' && options.locale !== '' ? options.locale.toLowerCase() : null
  const filtered = locale === null ? all : all.filter((voice) => voice.locale.toLowerCase().startsWith(locale))
  return { voices: filtered, total: all.length, url: voicesUrl(), attempts: used }
}

/**
 * What this provider needs, reported without touching the network.
 * @returns {object} the status of the provider.
 */
export function status() {
  return {
    id: PROVIDER_ID,
    available: true,
    requiresNetwork: true,
    requiresKey: false,
    keyless: true,
    timings: 'word-boundaries',
    timingsNote: '逐词时间来自服务端 WordBoundary 元数据，不是强制对齐；duration 是最后一个词的结束时刻，不含尾部静音。',
    voicesKnown: false,
    voicesNote: '音色表在服务端，用 tts_setup {action:"voices"} 现取；不缓存成常量。',
    outputFormat: OUTPUT_FORMAT,
  }
}

/**
 * The provider object the registry hands out.
 *
 * `speak` and `voices` are the same functions as the module exports, so a caller that imports the
 * module directly and one that goes through the provider registry cannot drift apart.
 */
export const edgeProvider = {
  id: PROVIDER_ID,
  kind: 'network',
  requiresNetwork: true,
  timings: 'word-boundaries',
  defaults: { voice: DEFAULT_VOICE, rate: '+0%', pitch: '+0Hz', volume: '+0%', timeoutMs: DEFAULT_TIMEOUT_MS },
  outputExtension: 'mp3',
  speak,
  voices,
  status,
}
