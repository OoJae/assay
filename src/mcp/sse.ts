import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  DISCLAIMER,
  TOOLS,
  buildServer,
  publicUnavailableReason,
  readSweepStatus,
  sweepHealth,
} from './server.js'
import { FINDINGS_PATH, loadSnapshot } from '../lib/surface.js'
import { redactSnapshot } from '../lib/redact.js'
import {
  RateLimiter,
  clientIp,
  trustedProxies,
  toolBucket,
  LIMITS,
  MAX_CONCURRENT_SESSIONS,
} from './ratelimit.js'

/**
 * ASSAY MCP server over HTTP: the legacy HTTP+SSE transport, and Streamable HTTP beside it.
 *
 * WHY SSE STAYS: the MCP SDK marks SSEServerTransport deprecated in favour of
 * StreamableHTTPServerTransport, but OpenServ's own MCP support is SSE-only
 * (docs.openserv.ai/no-code/connect/mcps: "OpenServ supports MCP over Server-Sent Events (SSE)
 * HTTP today. HTTP streaming isn't required"). Shipping only stdio meant no OpenServ workflow
 * could consume this server at all — which is a hole in a submission to the "Mainnet & MCP" track.
 *
 * WHY STREAMABLE HTTP WAS ADDED: the agent card advertises protocol 2025-06-18, whose transport it
 * is, and a client that speaks only that got a 404 here. It is stateless — a fresh server per POST,
 * no session to hold — so it adds no state for anyone to exhaust.
 *
 * Endpoints:
 *   GET  /sse            open the event stream; the server replies with the POST endpoint + sessionId
 *   POST /messages       client -> server JSON-RPC, routed by ?sessionId=
 *   POST /mcp            Streamable HTTP, stateless, JSON responses
 *   GET  /health         liveness, plus whether the sweep is still publishing
 *   GET  /health/sweep   the same, answering 503 when the sweep is not, for an external monitor
 *   GET  /findings.json  the published board, which the wall renders
 *
 * Safe to run with NO secrets: every tool is a public Robinhood Chain read. The exposure that
 * matters on a public endpoint is therefore COST, not data — assay_check_symbol runs a live sweep
 * per call — so per-IP rate limiting is applied before any work is done. See ./ratelimit.ts.
 */
const PORT = Number(process.env.MCP_PORT ?? 7379)
/**
 * Loopback by default.
 *
 * The default was '0.0.0.0', so the public deployment served the whole MCP surface directly on
 * an IP literal with no TLS. nginx terminates TLS and proxies to 127.0.0.1 (see
 * deploy/assay-mcp.nginx.conf); binding wide is now an explicit opt-in rather than what happens
 * if nobody thinks about it.
 */
const HOST = process.env.MCP_HOST ?? '127.0.0.1'

/**
 * Public path prefix, when nginx mounts this under a sub-path of an existing TLS host rather than
 * on its own subdomain.
 *
 * The SSE transport tells the client where to POST its side of the JSON-RPC conversation, and it
 * sends that as an ABSOLUTE path. Behind `location /assay-mcp/` with a prefix-stripping
 * proxy_pass, a bare '/messages' would send the client to the origin root — some other
 * application — so the advertised path has to carry the prefix even though this process still
 * sees the stripped one.
 *
 * Empty (the default) means mounted at the root, which is what a dedicated subdomain gives.
 */
const PUBLIC_PATH = (process.env.MCP_PUBLIC_PATH ?? '').replace(/\/$/, '')

/**
 * How many streams one address may HOLD, and for how long.
 *
 * THE GLOBAL CAP WAS NOT ENOUGH, and neither was the first per-address cap. 6 per IP against 50
 * in total meant nine addresses filled the server, and since any POST — a JSON-RPC ping — reset
 * the idle clock, one cheap request per stream every ten minutes held every slot for good. The
 * rate limiter governs how FAST you may connect; this governs how many you may hold.
 *  - 6 per address, against 200 in total, so filling the server takes 34 addresses, and the two
 *    rules below take back whatever they hold.
 *  - idle means no tool call. Pings, tools/list and notifications do not keep a stream alive.
 *  - 30 minutes at most, however busy. Clients reconnect; a held slot does not become permanent.
 *
 * WHY NOT 2, EVICTING THE OLDEST. That was the previous rule, and it turned clients behind one
 * egress IP (OpenServ's platform, any NAT) into a loop: the SDK's SSE client reconnects when its
 * stream closes, so with three of them each reconnect evicted another, which reconnected in turn.
 * Reproduced with three SDK clients on 127.0.0.1: 7 opens in 15 seconds with no activity, and a
 * tool call on an evicted session answered 404. Past four clients the reconnects passed the
 * 30-a-minute `conn` limit, and a 429 is fatal to EventSource. So an address at its cap may only
 * displace one of its own streams that has been idle for SESSION_EVICTABLE_MS, counted from its
 * open or its last tool call; anything busier is kept and the new stream is refused. A freshly
 * reconnected stream is therefore never the next one evicted, and eviction cannot cycle.
 */
export const MAX_SESSIONS_PER_IP = 6
export const SESSION_IDLE_MS = 10 * 60_000
export const SESSION_MAX_MS = 30 * 60_000
export const SESSION_EVICTABLE_MS = 2 * 60_000

/**
 * An SSE comment every 25 seconds on each open stream.
 *
 * With nothing on the wire, Node clients (undici's 300s body timeout) cut the stream every five
 * minutes and silently opened a new, uninitialised session; a response in flight at that moment
 * was lost. Measured with mcp-remote and the SDK's own client against the live endpoint. The
 * heartbeat does not count as activity for the idle rule above.
 */
export const HEARTBEAT_MS = 25_000

/**
 * CORS for a public, unauthenticated read API: any origin.
 *
 * Kept as `*` on purpose. Every tool is a free public chain read with per-IP limits, so a web page
 * calling it gets nothing a server-side script could not, and browser-hosted MCP clients (the
 * Inspector's direct mode, web agent UIs) need it. mcp-protocol-version is allowed because the
 * SDK's client sends it on every POST after initialize; without it a browser client initialised
 * and then had every later message blocked by its own preflight.
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
  'Access-Control-Max-Age': '600',
}

const MAX_BODY = 64 * 1024

export interface McpHttpOptions {
  publicPath?: string
  findingsPath?: string
  maxSessions?: number
  maxSessionsPerIp?: number
  sessionIdleMs?: number
  sessionMaxMs?: number
  sessionEvictableMs?: number
  heartbeatMs?: number
  /** Proxies whose X-Forwarded-For is believed. Production reads MCP_TRUSTED_PROXIES. */
  trusted?: Set<string>
  now?: () => number
}

interface Session {
  transport: SSEServerTransport
  ip: string
  openedAt: number
  /** The open, or the last tools/call accepted on this stream. Nothing else refreshes it. */
  lastSeen: number
  heartbeat?: ReturnType<typeof setInterval>
}

function tooMany(res: ServerResponse, retryAfter: number, detail: string) {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfter) })
  res.end(JSON.stringify({ error: 'rate limited', detail, retryAfterSeconds: retryAfter }))
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const NO_BODY = Symbol('no body')

/**
 * Read and parse a JSON-RPC body ourselves, so the tool name can be inspected BEFORE any work
 * happens; the transports accept the parsed body, so nothing is re-read. Answers the request itself
 * and returns NO_BODY when the body is unusable.
 */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const raw = await new Promise<string | null>((resolve) => {
    let buf = ''
    const onData = (c: Buffer | string) => {
      buf += c
      if (buf.length > MAX_BODY) {
        // reject() alone left the listener attached and kept buffering to Content-Length;
        // a 300MB body reached the heap limit. Detach first, then ANSWER, then tear down.
        //
        // The 413 below used to be unreachable: req.destroy() ran here, so by the time
        // res.writeHead(413) was called the socket was already gone and the client saw a reset
        // instead of a status. Telling a caller their body was too large is the whole point of
        // having a limit — a connection reset is indistinguishable from the server crashing,
        // which is exactly the wrong impression for this endpoint to give.
        req.off('data', onData)
        if (!res.headersSent) {
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
          res.end(JSON.stringify({ error: 'payload too large', maxBytes: MAX_BODY }))
        }
        req.destroy()
        resolve(null)
      }
    }
    req.on('data', onData)
    req.on('end', () => resolve(buf))
    req.on('error', () => resolve(null))
  })

  if (raw === null) {
    // The oversized case already answered above, before destroying the socket. This covers a
    // stream that errored for another reason.
    if (!res.headersSent) json(res, 400, { error: 'could not read request body' })
    return NO_BODY
  }
  try {
    return JSON.parse(raw)
  } catch {
    json(res, 400, { error: 'invalid JSON' })
    return NO_BODY
  }
}

/** The tools/call messages in a body, which may be one message or a batch. */
function toolCalls(body: unknown): string[] {
  const msgs = Array.isArray(body) ? body : [body]
  return msgs
    .filter((m) => (m as { method?: string } | null)?.method === 'tools/call')
    .map((m) => String((m as { params?: { name?: string } }).params?.name ?? ''))
}

function startHeartbeat(res: ServerResponse, ms: number): ReturnType<typeof setInterval> | undefined {
  if (!(ms > 0)) return undefined
  const t = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n')
  }, ms)
  t.unref()
  return t
}

export function createMcpHttp(opts: McpHttpOptions = {}) {
  const publicPath = opts.publicPath ?? PUBLIC_PATH
  const findingsPath = opts.findingsPath ?? FINDINGS_PATH
  const maxSessions = opts.maxSessions ?? MAX_CONCURRENT_SESSIONS
  const maxPerIp = opts.maxSessionsPerIp ?? MAX_SESSIONS_PER_IP
  const idleMs = opts.sessionIdleMs ?? SESSION_IDLE_MS
  const maxMs = opts.sessionMaxMs ?? SESSION_MAX_MS
  const evictableMs = opts.sessionEvictableMs ?? SESSION_EVICTABLE_MS
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  const trusted = opts.trusted ?? trustedProxies()
  const now = opts.now ?? Date.now

  /** One transport per connected SSE client, routed by sessionId on the POST leg. */
  const sessions = new Map<string, Session>()

  function dropSession(id: string) {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    if (s.heartbeat) clearInterval(s.heartbeat)
    // Closing the transport releases the underlying response; without it an abandoned stream keeps
    // its socket and its slot until the client happens to disconnect.
    try {
      void s.transport.close()
    } catch {
      /* already gone */
    }
  }

  /** Close streams past their lifetime or idle past the limit. Returns how many were closed. */
  function reap(at = now()): number {
    let closed = 0
    for (const [id, s] of sessions) {
      const why = at - s.openedAt >= maxMs ? 'lifetime' : at - s.lastSeen >= idleMs ? 'idle' : null
      if (!why) continue
      console.warn(`[mcp] closing session ${id.slice(0, 8)} (${why}) for ${s.ip}`)
      dropSession(id)
      closed++
    }
    return closed
  }

  const limiter = new RateLimiter()
  // Unref'd so these timers never hold the process open.
  const timers = [setInterval(() => reap(), 60_000), setInterval(() => limiter.sweep(now()), 60_000)]
  for (const t of timers) t.unref()

  /** Meter each tools/call in its own bucket. False when the request was answered with a 429. */
  function meterTools(body: unknown, ip: string, res: ServerResponse): boolean {
    for (const tool of toolCalls(body)) {
      const b = toolBucket(tool)
      const wait = limiter.check(`${b.key}:${ip}`, b.limit, now())
      if (wait !== null) {
        tooMany(res, wait, `rate limit for ${b.label} tools`)
        return false
      }
    }
    return true
  }

  function endpoints() {
    return ['/sse', '/messages', '/mcp', '/health', '/health/sweep', '/findings.json'].map((p) => publicPath + p)
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Fixed base: the Host header is attacker-controlled and unused.
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v)

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket.remoteAddress, trusted)

    /**
     * EXACT matching against the two shapes this process can legitimately see.
     *
     * nginx strips the mount prefix (`proxy_pass http://127.0.0.1:7379/`), so a request to
     * /assay-mcp/sse arrives here as /sse. But when MCP_PUBLIC_PATH is set and something forwards
     * the prefix intact, /assay-mcp/sse arrives whole — so both are accepted and nothing else is.
     *
     * This was `route.endsWith(p)`, which matched /evil/sse and /anything/you/like/sse. Measured:
     * GET /evil/sse returned 200 and opened a real session. Not a privilege hole — same handler,
     * same limits — but on a shared origin, responding on paths this service does not own is the
     * kind of sloppiness that turns into a cache-poisoning or routing bug later.
     */
    const route = url.pathname.replace(/\/+$/, '') || '/'
    const is = (p: string) => route === p || (publicPath !== '' && route === publicPath + p)
    const read = req.method === 'GET' || req.method === 'HEAD'

    /**
     * Liveness, and whether the sweep is still publishing.
     *
     * Session counts used to be here, publicly, which let anyone holding the slots confirm the
     * lockout. What is here instead is what a monitor needs: /health answers 200 while this
     * process serves, and /health/sweep answers 503 when the board has gone stale or the last run
     * refused to publish, so an external check can alert on it.
     */
    // HEAD as well as GET: `curl -I` is the first thing anyone runs against a new endpoint, and
    // falling through to 404 makes a healthy server look broken.
    if (read && (is('/health') || is('/health/sweep'))) {
      const sweep = sweepHealth(loadSnapshot(findingsPath), readSweepStatus(findingsPath), now())
      const strict = is('/health/sweep')
      const status = strict && !sweep.healthy ? 503 : 200
      const body = strict
        ? { ok: sweep.healthy, sweep }
        : { ok: true, transports: { sse: `${publicPath}/sse`, streamableHttp: `${publicPath}/mcp` }, sweep }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body))
      return
    }

    /**
     * The published sweep as plain JSON.
     *
     * WHY THIS EXISTS. The sweep timer on this host regenerates the board every 8 minutes, but the
     * WALL is a separate deployment reading a copy committed at build time — so fixing the
     * regeneration only fixed half the staleness. Every citation carries a "reproduce this yourself"
     * command against a block this RPC serves for 5,000-10,000 blocks (~8-17 minutes), so a wall that only updates
     * when someone redeploys is publishing commands that stopped working hours ago.
     *
     * The wall fetches this at request time and falls back to its committed copy when this host is
     * unreachable, so the endpoint being down degrades freshness rather than emptying the board.
     * A refusing sweep does NOT make this `available: false` — that would send the wall back to its
     * build-time copy on every transient refusal — it is stated in `sweepHealth` instead.
     *
     * Metered like any other cheap read, and served from the same mtime-keyed cache the MCP tools use.
     */
    if (read && is('/findings.json')) {
      const wait = limiter.check(`cheap:${ip}`, LIMITS.cheapCall, now())
      if (wait !== null) {
        tooMany(res, wait, 'too many requests from this address')
        return
      }
      const snap = loadSnapshot(findingsPath)
      // PUBLIC FEED. Named integrator findings are stripped here too, from `rejected` as well as
      // `findings`: this endpoint is what the wall renders, so leaving them in would publish by the
      // back door exactly the names the wall is designed not to show.
      const pub = redactSnapshot(snap as Parameters<typeof redactSnapshot>[0])
      const health = sweepHealth(snap, readSweepStatus(findingsPath), now())
      const body = JSON.stringify({
        ...pub,
        ...(snap.unavailableReason ? { unavailableReason: publicUnavailableReason(snap.unavailableReason) } : {}),
        snapshotAgeSeconds: health.boardAgeSeconds,
        sweepHealth: health,
        disclaimer: DISCLAIMER,
      })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        // Short, because the point of the endpoint is freshness.
        'cache-control': 'public, max-age=60',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    if (req.method === 'GET' && is('/sse')) {
      const wait = limiter.check(`conn:${ip}`, LIMITS.connection, now())
      if (wait !== null) {
        tooMany(res, wait, 'too many connections from this address')
        return
      }
      // At its cap, this address may displace only its own stream that has sat idle long enough;
      // otherwise the new one is refused (see MAX_SESSIONS_PER_IP for the loop this prevents).
      const at = now()
      const mine = [...sessions].filter(([, s]) => s.ip === ip).sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      while (mine.length >= maxPerIp) {
        const [id, oldest] = mine[0]!
        const idleFor = at - oldest.lastSeen
        if (idleFor < evictableMs) {
          tooMany(
            res,
            Math.max(1, Math.ceil((evictableMs - idleFor) / 1000)),
            `this address already holds ${maxPerIp} streams in use; close one or retry`,
          )
          return
        }
        mine.shift()
        dropSession(id)
      }
      if (sessions.size >= maxSessions) {
        tooMany(res, 30, 'the server is at its session cap; retry shortly')
        return
      }
      const transport = new SSEServerTransport(`${publicPath}/messages`, res)
      const server = buildServer({ ip })
      const session: Session = { transport, ip, openedAt: at, lastSeen: at }
      sessions.set(transport.sessionId, session)
      // Drop the session when the client disconnects, or the map leaks one entry per connection.
      transport.onclose = () => dropSession(transport.sessionId)
      res.on('close', () => dropSession(transport.sessionId))
      await server.connect(transport)
      // After connect, which wrote the headers and the endpoint event.
      if (sessions.has(transport.sessionId)) session.heartbeat = startHeartbeat(res, heartbeatMs)
      return
    }

    if (req.method === 'POST' && is('/sse')) {
      // A Streamable HTTP client POSTs to the URL it was given; the README gives this one. Any 4xx
      // sends a spec-following client to GET, and this says where the new transport is.
      json(
        res,
        405,
        { error: `this is the legacy HTTP+SSE endpoint: open it with GET, or POST JSON-RPC to ${publicPath}/mcp` },
        { allow: 'GET' },
      )
      return
    }

    if (req.method === 'POST' && (is('/messages') || is('/mcp'))) {
      // METER FIRST, before the session lookup.
      //
      // The unknown-session 404 used to return ahead of the limiter, so POSTing a bogus sessionId
      // was an unmetered path: unlimited requests, each doing a map lookup and a response write,
      // and none of them counted. A limiter with a free door next to it is not a limiter.
      const entry = limiter.check(`post:${ip}`, LIMITS.cheapCall, now())
      if (entry !== null) {
        tooMany(res, entry, 'too many requests from this address')
        req.destroy()
        return
      }

      let session: Session | undefined
      if (is('/messages')) {
        const sessionId = url.searchParams.get('sessionId')
        session = sessionId ? sessions.get(sessionId) : undefined
        if (!session) {
          json(res, 404, { error: `unknown or expired sessionId — reopen GET ${publicPath}/sse` })
          return
        }
      }

      // The cheap-call meter already ran above, before the session lookup: previously only
      // `tools/call` was metered, and only after the whole body had been read and parsed — so
      // initialize/tools/list/ping and every notification were free, and the read itself was the
      // cheapest way to make the server do work.
      const body = await readJson(req, res)
      if (body === NO_BODY) return
      if (!meterTools(body, ip, res)) return

      if (session) {
        if (toolCalls(body).length) session.lastSeen = now()
        await session.transport.handlePostMessage(req, res, body)
        return
      }

      // Streamable HTTP, stateless: a fresh server and transport per request, as the SDK requires.
      const server = buildServer({ ip })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
      return
    }

    if (is('/mcp')) {
      // Stateless: no server-initiated stream to open with GET and no session to DELETE.
      json(
        res,
        405,
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: POST JSON-RPC here.' }, id: null },
        { allow: 'POST' },
      )
      return
    }

    json(res, 404, { error: 'not found', endpoints: endpoints() })
  }

  const http: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handle(req, res)
    } catch (err) {
      console.error('[mcp] request failed:', err instanceof Error ? err.message : err)
      if (!res.headersSent) {
        json(res, 400, { error: 'bad request' })
      } else {
        res.end()
      }
    }
  })

  return {
    http,
    reap,
    /** Open SSE streams. For tests and the log, never the public payload. */
    sessionCount: () => sessions.size,
    close() {
      for (const t of timers) clearInterval(t)
      for (const id of [...sessions.keys()]) dropSession(id)
      http.closeAllConnections()
      http.close()
    },
  }
}

/** True when this file is the process entrypoint rather than imported, e.g. by a test. */
function isEntrypoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  /**
   * A crashed process is a denial of service on the one judge-facing endpoint, so nothing in the
   * request path may throw out of the handler.
   *
   * The concrete bug this closes: the URL was parsed against `http://${req.headers.host}`, and Node's
   * HTTP parser accepts hosts the WHATWG URL parser rejects. A single request with `Host: ]` threw
   * ERR_INVALID_URL out of an unguarded async handler and killed the process; the next request got
   * connection refused. The host is never used — only pathname and searchParams are read — so it is
   * parsed against a fixed base instead.
   */
  process.on('unhandledRejection', (err) => {
    console.error('[mcp] unhandled rejection:', err instanceof Error ? err.message : err)
  })
  process.on('uncaughtException', (err) => {
    console.error('[mcp] uncaught exception:', err instanceof Error ? err.message : err)
  })

  // Behind a loopback proxy with no trusted peer, every client is 127.0.0.1: one rate-limit bucket
  // and two SSE slots for the whole world, each new client evicting the last.
  if (trustedProxies().size === 0 && (HOST === '127.0.0.1' || HOST === '::1')) {
    console.warn('[mcp] MCP_TRUSTED_PROXIES is empty: behind a proxy, every client would share one identity')
  }

  const { http } = createMcpHttp()
  http.listen(PORT, HOST, () => {
    console.log(`ASSAY MCP listening on http://${HOST}:${PORT}${PUBLIC_PATH}/sse (SSE) and ${PUBLIC_PATH}/mcp (Streamable HTTP)`)
    if (PUBLIC_PATH) console.log(`SSE clients are told to POST to ${PUBLIC_PATH}/messages`)
    console.log(`tools: ${TOOLS.join(', ')}`)
  })
}
