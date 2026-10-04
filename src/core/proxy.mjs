/**
 * Reaching the network through the system proxy.
 *
 * Node's global `fetch` reads neither the Windows registry nor `HTTPS_PROXY` (verified on
 * Node 24: setting the variable and `NODE_USE_ENV_PROXY=1` both still went direct and timed
 * out), while PowerShell, browsers, and every other Windows program do use the registry
 * setting. Any module here that opens its own socket therefore has to build the tunnel by
 * hand, and this is the one place that knows how.
 *
 * Two callers need it for two different reasons, which is why it lives on its own: the
 * read-aloud WebSocket in `ws.mjs` needs a `CONNECT` tunnel before its TLS handshake, and the
 * voice-list request in `providers/edge.mjs` opens an HTTPS connection of its own rather than
 * going through the host's fetch. Without this, both fail on a proxied network with a bare
 * connection error while `curl` and the browser work.
 *
 * @module dsh-tts/core/proxy
 */
import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

/**
 * The proxy Node should reach the network through, if a system one is configured.
 *
 * Resolution order: an explicit environment variable wins, then the Windows registry. The
 * value is returned as a `host:port` authority, ready for a CONNECT request.
 *
 * @returns {string|null} `host:port`, or null when no proxy is configured.
 */
export function systemProxy() {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  }
  if (process.platform !== 'win32') return null

  // Read the registry directly rather than shelling out: this runs on every networked call,
  // and spawning a process to answer "is a proxy set" would cost more than the answer is worth.
  try {
    const query = (name) =>
      execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      })
    const enabled = /REG_DWORD\s+0x1\b/i.test(query('ProxyEnable'))
    if (!enabled) return null
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(query('ProxyServer'))
    if (match === null) return null
    const raw = match[1]
    // A per-protocol list looks like `http=host:port;https=host:port`; take the https entry.
    const perProtocol = /https?=([^;]+)/i.exec(raw)
    const authority = (perProtocol === null ? raw : perProtocol[1]).replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    return authority === '' ? null : authority
  } catch {
    // A missing or unreadable key simply means no proxy.
    return null
  }
}

/**
 * Open a TLS connection to the target, tunnelling through a proxy when one is configured.
 *
 * A CONNECT tunnel hands back a plain TCP socket. `https.request` cannot use that directly —
 * handing it a bare socket produces a bare `socket hang up` — so the TLS handshake is performed
 * here over the tunnelled socket with SNI set to the real hostname, and the resulting TLSSocket
 * is what the request consumes.
 *
 * The returned socket has **already completed** its TLS handshake, so a caller that would
 * normally wait for `secureConnect` must send immediately instead; that event will not fire
 * again on a socket handed back from here.
 *
 * @param {URL} target - the destination.
 * @param {string} proxy - `host:port` of the proxy.
 * @param {number} timeoutMs - connect timeout.
 * @returns {Promise<{socket: import('node:tls').TLSSocket, close: () => void}>} the ready socket.
 * @throws {Error} when the proxy refuses or the TLS handshake fails.
 */
export function connectThroughProxy(target, proxy, timeoutMs = 60_000) {
  const [host, rawPort] = proxy.split(':')
  const port = Number(rawPort ?? 8080)
  const targetPort = target.port === '' ? 443 : Number(target.port)
  const authority = `${target.hostname}:${targetPort}`

  return new Promise((settle, fail) => {
    const request = httpRequest({ host, port, method: 'CONNECT', path: authority, timeout: timeoutMs })
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        fail(new Error(`代理 ${proxy} 拒绝建立到 ${authority} 的隧道：HTTP ${response.statusCode}`))
        return
      }
      const secure = tlsConnect({ socket, servername: target.hostname })
      secure.once('secureConnect', () => settle({ socket: secure, close: () => secure.destroy() }))
      secure.once('error', (error) => {
        secure.destroy()
        fail(new Error(`经代理 ${proxy} 与 ${authority} 完成 TLS 握手失败：${error.message}`))
      })
    })
    request.on('timeout', () => request.destroy(new Error(`连接代理 ${proxy} 超时`)))
    request.on('error', (error) => fail(new Error(`无法通过代理 ${proxy} 连接：${error.message}`)))
    request.end()
  })
}

/**
 * One GET request that goes through the system proxy when there is one.
 *
 * Node's `fetch` cannot be pointed at a CONNECT tunnel, so the request is made with
 * `node:https` over a socket that this module opened — direct when there is no proxy, tunnelled
 * when there is. The body is collected and returned as text; a non-2xx status is reported as a
 * failure with the status line, because both call sites only ever want the payload.
 *
 * @param {string} url - the absolute `https://` URL to fetch.
 * @param {object} [options] - request options.
 * @param {Record<string,string>} [options.headers] - extra request headers.
 * @param {number} [options.timeoutMs] - total timeout; defaults to 60000.
 * @returns {Promise<{status: number, text: string}>} the status code and the decoded body.
 * @throws {Error} when the connection, the proxy, or the status fails.
 */
export function httpsGetText(url, options = {}) {
  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error(`httpsGetText only supports https://, got ${target.protocol}`)
  const timeoutMs = options.timeoutMs ?? 60_000
  const proxy = systemProxy()

  return new Promise((settle, fail) => {
    /** Issue the request over a socket that is already usable. */
    const issue = (socket) => {
      const request = httpsRequest(
        {
          host: target.hostname,
          port: target.port === '' ? 443 : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { 'Accept-Encoding': 'identity', ...(options.headers ?? {}) },
          ...(socket === null ? {} : { createConnection: () => socket, agent: false }),
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            if (socket !== null) socket.destroy()
            const status = response.statusCode ?? 0
            if (status < 200 || status >= 300) {
              fail(new Error(`HTTP ${status} ${response.statusMessage ?? ''}`.trim()))
              return
            }
            settle({ status, text: Buffer.concat(chunks).toString('utf8') })
          })
        },
      )
      request.on('error', (error) => fail(error))
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
      request.end()
    }

    if (proxy === null) {
      issue(null)
      return
    }
    connectThroughProxy(target, proxy, timeoutMs).then(
      ({ socket }) => issue(socket),
      (error) => fail(error),
    )
  })
}
