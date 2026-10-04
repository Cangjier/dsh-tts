/**
 * A minimal RFC 6455 WebSocket client, built on `node:tls`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Edge's read-aloud endpoint requires `Origin`, a `Cookie`, and its signature in the
 * query string, so Node's global `WebSocket` — which cannot set request headers at
 * all — cannot reach the service, and the `ws` package would add a dependency for a
 * single call site. This module speaks the wire protocol directly instead.
 *
 * What it deliberately does NOT do: permessage-deflate. The service refuses the
 * negotiation in practice, so the handshake sends no `Sec-WebSocket-Extensions`
 * header and {@link connect}'s result always reports `compressed === false`.
 * Sending that header is what makes the exchange fragile, so it is simply absent.
 *
 * PROXY
 * -----
 * When the machine reaches the internet only through a system proxy, a bare
 * `tls.connect` to this host is reset before the TLS handshake finishes. That is not a
 * hypothetical: narration synthesis failed with `ECONNRESET` on such a machine while every
 * other networked call worked, because those had learned to tunnel and this transport had
 * not. The socket is therefore established through {@link connectThroughProxy} whenever
 * {@link systemProxy} reports one, which also means {@link connect} can no longer create
 * its socket synchronously — it returns the emitter immediately and establishes the socket
 * in the background, exactly as it did before, so callers attach their listeners the same
 * way.
 *
 * @module dsh-tts/core/ws
 */
import tls from 'node:tls'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { connectThroughProxy, systemProxy } from './proxy.mjs'

/** The RFC 6455 handshake GUID, concatenated with the client key and SHA-1'd. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** RFC 6455 opcodes this client understands. */
const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

/** Default handshake timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15000

/** Largest frame this client will accept, purely so a bogus header cannot allocate. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/**
 * Encode one client-to-server frame.
 *
 * Two details here are load-bearing and were each the cause of a hard-to-find
 * failure: byte 1 MUST carry the MASK bit (0x80), because RFC 6455 requires every
 * client frame to be masked and a server may reset the connection on an unmasked
 * one; and the 4-byte mask key MUST be appended *after* the length field, so the
 * frame is `header + mask + masked`. Writing the mask at `header.length - 4`
 * overwrites the FIN/opcode byte and corrupts the frame.
 *
 * @param {number} opcode - one of {@link OPCODE}.
 * @param {Buffer|string} payload - the frame body.
 * @param {boolean} [fin] - whether this is the final fragment.
 * @returns {Buffer} the masked frame, ready to be written to the socket.
 */
function encodeFrame(opcode, payload, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const length = data.length

  let header
  if (length < 126) {
    // 7-bit length.
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    // 16-bit extended length.
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    // 64-bit extended length.
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)

  const mask = crypto.randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) masked[index] = data[index] ^ mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

/**
 * Parse an HTTP message head into a status line plus a lowercase header map.
 * @param {string} text - the head, up to but excluding the blank line.
 * @returns {{statusLine: string, headers: Map<string,string>}} the parsed head.
 */
function parseHead(text) {
  const lines = text.split('\r\n')
  const headers = new Map()
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':')
    if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim())
  }
  return { statusLine: lines[0] ?? '', headers }
}

/**
 * Open a WebSocket connection and complete the HTTP Upgrade handshake.
 *
 * The returned emitter is the socket: it emits `open`, `text` (Buffer), `binary`
 * (Buffer), `close` and `error`, and carries `send`, `close`, `destroy` and the
 * `compressed` flag. `text` and `binary` always deliver one whole message, with
 * fragments already reassembled.
 *
 * The socket is established synchronously when no proxy is configured and through a
 * `CONNECT` tunnel otherwise, so either way an error surfaces on `error` rather than by
 * throwing from this call. A proxied socket arrives with its TLS handshake already
 * complete, which is why the upgrade request is sent immediately in that case instead of
 * waiting for `secureConnect`.
 *
 * @param {object} options - connection options.
 * @param {string} options.url - a `wss://` URL; the query string is sent verbatim.
 * @param {Record<string,string>} [options.headers] - extra request headers, such as `Origin` and `Cookie`.
 * @param {number} [options.timeoutMs] - handshake timeout; the socket is destroyed when it elapses.
 * @returns {EventEmitter} the socket.
 */
export function connect(options) {
  const url = new URL(options.url)
  if (url.protocol !== 'wss:') throw new Error(`ws.mjs only supports wss://, got ${url.protocol}`)

  const emitter = new EventEmitter()
  const key = crypto.randomBytes(16).toString('base64')
  const expectedAccept = crypto.createHash('sha1').update(key + GUID).digest('base64')
  const port = url.port === '' ? 443 : Number(url.port)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let socket = null
  let abandoned = false
  let handshakeDone = false
  let closing = false
  let closeEmitted = false
  let inbound = Buffer.alloc(0)
  let fragment = null

  // The caller attaches listeners after `connect()` returns, so an error raised
  // before then would otherwise become an uncaught exception. Remember it and hand
  // it to the first `error` listener instead of dropping it on the floor.
  let pendingError = null
  const report = (error) => {
    if (emitter.listenerCount('error') > 0) {
      emitter.emit('error', error)
      return
    }
    pendingError = error
  }
  emitter.on('newListener', (event) => {
    if (event !== 'error' || pendingError === null) return
    const error = pendingError
    pendingError = null
    queueMicrotask(() => emitter.emit('error', error))
  })
  const emitClose = () => {
    if (closeEmitted) return
    closeEmitted = true
    emitter.emit('close')
  }
  const fail = (error) => {
    abandoned = true
    report(error)
    // Before the tunnel resolves there is no socket to destroy, and a caller waiting on
    // `close` still has to be released.
    if (socket === null || socket.destroyed) emitClose()
    else socket.destroy()
  }

  const timer = setTimeout(() => fail(new Error(`websocket handshake timed out after ${timeoutMs}ms`)), timeoutMs)

  const sendHandshake = () => {
    const lines = [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]
    // No Sec-WebSocket-Extensions line: permessage-deflate is not implemented.
    for (const [name, value] of Object.entries(options.headers ?? {})) lines.push(`${name}: ${value}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  }

  /**
   * Wire up a socket that is ready to carry the upgrade request.
   * @param {import('node:tls').TLSSocket} ready - the socket.
   * @param {boolean} secureAlreadyDone - true for a proxied socket, which has already completed TLS.
   */
  const attach = (ready, secureAlreadyDone) => {
    socket = ready
    socket.setNoDelay(true)

    socket.on('error', (error) => {
      clearTimeout(timer)
      report(error)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      emitClose()
    })

    socket.on('data', (chunk) => {
      inbound = inbound.length === 0 ? chunk : Buffer.concat([inbound, chunk])

      if (!handshakeDone) {
        const end = inbound.indexOf('\r\n\r\n')
        if (end < 0) return // the head has not fully arrived yet
        const { statusLine, headers } = parseHead(inbound.subarray(0, end).toString('latin1'))
        inbound = inbound.subarray(end + 4)

        if (!/^HTTP\/1\.1 101/.test(statusLine)) {
          clearTimeout(timer)
          fail(new Error(`websocket upgrade refused: ${statusLine}`))
          return
        }
        if (headers.get('sec-websocket-accept') !== expectedAccept) {
          clearTimeout(timer)
          fail(new Error('websocket handshake failed: bad Sec-WebSocket-Accept'))
          return
        }
        handshakeDone = true
        clearTimeout(timer)
        // permessage-deflate is intentionally never negotiated.
        emitter.compressed = false
        emitter.emit('open')
      }

      for (;;) {
        if (inbound.length < 2) return
        const first = inbound[0]
        const second = inbound[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2

        if (length === 126) {
          if (inbound.length < offset + 2) return
          length = inbound.readUInt16BE(offset)
          offset += 2
        } else if (length === 127) {
          if (inbound.length < offset + 8) return
          const big = inbound.readBigUInt64BE(offset)
          offset += 8
          if (big > BigInt(MAX_FRAME_BYTES)) {
            fail(new Error(`websocket frame too large: ${big} bytes`))
            return
          }
          length = Number(big)
        }

        let maskKey = null
        if (masked) {
          if (inbound.length < offset + 4) return
          maskKey = inbound.subarray(offset, offset + 4)
          offset += 4
        }
        if (inbound.length < offset + length) return

        let payload = inbound.subarray(offset, offset + length)
        if (maskKey) {
          const unmasked = Buffer.allocUnsafe(length)
          for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ maskKey[index % 4]
          payload = unmasked
        }
        inbound = inbound.subarray(offset + length)

        if (opcode === OPCODE.ping) {
          socket.write(encodeFrame(OPCODE.pong, payload))
          continue
        }
        if (opcode === OPCODE.pong) continue
        if (opcode === OPCODE.close) {
          if (!closing) socket.end(encodeFrame(OPCODE.close, Buffer.alloc(0)))
          return
        }

        if (opcode === OPCODE.continuation) {
          if (fragment === null) {
            fail(new Error('websocket protocol error: continuation frame without a start frame'))
            return
          }
          fragment.chunks.push(payload)
          if (fin) {
            const message = fragment.chunks.length === 1 ? fragment.chunks[0] : Buffer.concat(fragment.chunks)
            emitter.emit(fragment.opcode === OPCODE.text ? 'text' : 'binary', message)
            fragment = null
          }
          continue
        }

        if (opcode !== OPCODE.text && opcode !== OPCODE.binary) {
          fail(new Error(`websocket protocol error: unsupported opcode 0x${opcode.toString(16)}`))
          return
        }
        if (!fin) {
          fragment = { opcode, chunks: [payload] }
          continue
        }
        emitter.emit(opcode === OPCODE.text ? 'text' : 'binary', payload)
      }
    })

    if (secureAlreadyDone) sendHandshake()
    else socket.on('secureConnect', sendHandshake)
  }

  const proxy = systemProxy()
  if (proxy === null) {
    attach(tls.connect({ host: url.hostname, port, servername: url.hostname }), false)
  } else {
    connectThroughProxy(url, proxy, timeoutMs).then(
      ({ socket: tunnelled }) => {
        // The handshake timer may already have fired; a socket arriving after that is not
        // wanted, and leaving it open would keep the process alive.
        if (abandoned) {
          tunnelled.destroy()
          return
        }
        attach(tunnelled, true)
      },
      (error) => fail(error),
    )
  }

  /** Send one text message. @param {string|Buffer} payload - the message body. */
  emitter.send = (payload) => {
    if (socket === null || socket.destroyed) return
    socket.write(encodeFrame(OPCODE.text, payload))
  }
  /** Send a close frame and end the stream. */
  emitter.close = () => {
    if (socket === null || socket.destroyed) return
    closing = true
    socket.end(encodeFrame(OPCODE.close, Buffer.alloc(0)))
  }
  /** Tear the connection down immediately. */
  emitter.destroy = () => {
    if (socket !== null) socket.destroy()
  }
  emitter.compressed = false

  return emitter
}
