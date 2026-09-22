import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { buildServer } from './server.js'
import { loadSnapshot } from '../lib/surface.js'
import {
  RateLimiter,
  clientIp,
  LIMITS,
  EXPENSIVE_TOOLS,
  MAX_CONCURRENT_SESSIONS,
} from './ratelimit.js'

/**
 * ASSAY MCP server over SSE.
 *
 * WHY SSE and not Streamable HTTP: the MCP SDK marks SSEServerTransport deprecated in favour of
 * StreamableHTTPServerTransport, but OpenServ's own MCP support is SSE-only
 * (docs.openserv.ai/no-code/connect/mcps: "OpenServ supports MCP over Server-Sent Events (SSE)
 * HTTP today. HTTP streaming isn't required"). Shipping only stdio meant no OpenServ workflow
 * could consume this server at all — which is a hole in a submission to the "Mainnet & MCP" track.
 *
 * Endpoints:
 *   GET  /sse        open the event stream; the server replies with the POST endpoint + sessionId
 *   POST /messages   client -> server JSON-RPC, routed by ?sessionId=
 *   GET  /health     liveness, so the VPS unit can be checked without an MCP client
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

/** One transport per connected client, routed by sessionId on the POST leg. */
const sessions = new Map<string, SSEServerTransport>()

/**
 * Who owns each session, and when it was last used.
 *
 * THE GLOBAL CAP WAS NOT ENOUGH. 50 concurrent sessions with no per-address limit and no idle
 * timeout meant a single caller could open 50 streams, hold them open doing nothing, and keep the
 * public endpoint closed to everyone else indefinitely — at a cost of 50 requests, which is inside
 * the connection rate limit. The rate limiter governs how FAST you may connect; nothing governed
 * how many you could HOLD.
 */
const MAX_SESSIONS_PER_IP = 6
const SESSION_IDLE_MS = 10 * 60_000
const sessionMeta = new Map<string, { ip: string; lastSeen: number }>()

function sessionsForIp(ip: string): number {
  let n = 0
  for (const m of sessionMeta.values()) if (m.ip === ip) n++
  return n
}

function dropSession(id: string) {
  const t = sessions.get(id)
  sessions.delete(id)
  sessionMeta.delete(id)
  // Closing the transport releases the underlying response; without it an abandoned stream keeps
  // its socket and its slot until the client happens to disconnect.
  try {
    void t?.close?.()
  } catch {
    /* already gone */
  }
}

// Reap idle sessions so a slot cannot be held forever by a client that stopped talking.
setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS
  for (const [id, m] of sessionMeta) {
    if (m.lastSeen < cutoff) {
      console.warn(`[mcp] reaping idle session ${id} (${m.ip})`)
      dropSession(id)
    }
  }
}, 60_000).unref()

const limiter = new RateLimiter()
// Reap expired buckets periodically; unref so this timer never holds the process open.
setInterval(() => limiter.sweep(), 60_000).unref()

function tooMany(res: ServerResponse, retryAfter: number, detail: string) {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfter) })
  res.end(JSON.stringify({ error: 'rate limited', detail, retryAfterSeconds: retryAfter }))
}

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

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

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    await handle(req, res)
  } catch (err) {
    console.error('[mcp] request failed:', err instanceof Error ? err.message : err)
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad request' }))
    } else {
      res.end()
    }
  }
})

async function handle(req: IncomingMessage, res: ServerResponse) {
  // Fixed base: the Host header is attacker-controlled and unused.
  const url = new URL(req.url ?? '/', 'http://localhost')
  cors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket.remoteAddress)

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
  const is = (p: string) => route === p || (PUBLIC_PATH !== '' && route === PUBLIC_PATH + p)

  // HEAD as well as GET: `curl -I` is the first thing anyone runs against a new endpoint, and
  // falling through to 404 makes a healthy server look broken.
  if ((req.method === 'GET' || req.method === 'HEAD') && is('/health')) {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/json' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        transport: 'sse',
        sessions: sessions.size,
        maxSessions: MAX_CONCURRENT_SESSIONS,
        trackedClients: limiter.size,
      }),
    )
    return
  }

  /**
   * The published sweep as plain JSON.
   *
   * WHY THIS EXISTS. The sweep timer on this host regenerates data/findings.json every 30 minutes,
   * but the WALL is a separate deployment reading a copy committed at build time — so fixing the
   * regeneration only fixed half the staleness. Every citation carries a "reproduce this yourself"
   * command against a block this RPC serves for 5,000-10,000 blocks (~8-17 minutes), so a wall that only updates
   * when someone redeploys is publishing commands that stopped working hours ago.
   *
   * The wall fetches this at request time and falls back to its committed copy when this host is
   * unreachable, so the endpoint being down degrades freshness rather than emptying the board.
   *
   * Metered like any other cheap read, and served from the same mtime-keyed cache the MCP tools use.
   */
  if ((req.method === 'GET' || req.method === 'HEAD') && is('/findings.json')) {
    const wait = limiter.check(`cheap:${ip}`, LIMITS.cheapCall)
    if (wait !== null) {
      tooMany(res, wait, 'too many requests from this address')
      return
    }
    const snap = loadSnapshot()
    const body = JSON.stringify(snap)
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      // Short, because the point of the endpoint is freshness.
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }

  if (req.method === 'GET' && is('/sse')) {
    if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
      tooMany(res, 30, `server is at its ${MAX_CONCURRENT_SESSIONS}-session cap`)
      return
    }
    const wait = limiter.check(`conn:${ip}`, LIMITS.connection)
    if (wait !== null) {
      tooMany(res, wait, 'too many connections from this address')
      return
    }
    if (sessionsForIp(ip) >= MAX_SESSIONS_PER_IP) {
      tooMany(
        res,
        60,
        `this address already holds ${MAX_SESSIONS_PER_IP} open sessions; close one before opening another`,
      )
      return
    }
    const transport = new SSEServerTransport(`${PUBLIC_PATH}/messages`, res)
    const server = buildServer()
    sessions.set(transport.sessionId, transport)
    sessionMeta.set(transport.sessionId, { ip, lastSeen: Date.now() })
    // Drop the session when the client disconnects, or the map leaks one entry per connection.
    transport.onclose = () => dropSession(transport.sessionId)
    res.on('close', () => dropSession(transport.sessionId))
    await server.connect(transport)
    return
  }

  if (req.method === 'POST' && is('/messages')) {
    // METER FIRST, before the session lookup.
    //
    // The unknown-session 404 used to return ahead of the limiter, so POSTing a bogus sessionId
    // was an unmetered path: unlimited requests, each doing a map lookup and a response write,
    // and none of them counted. A limiter with a free door next to it is not a limiter.
    const entry = limiter.check(`post:${ip}`, LIMITS.cheapCall)
    if (entry !== null) {
      tooMany(res, entry, 'too many requests from this address')
      req.destroy()
      return
    }

    const sessionId = url.searchParams.get('sessionId')
    const transport = sessionId ? sessions.get(sessionId) : undefined
    if (sessionId) {
      const m = sessionMeta.get(sessionId)
      if (m) m.lastSeen = Date.now()
    }
    if (!transport) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown or expired sessionId — reopen GET /sse' }))
      return
    }

    // Read the body ourselves so the tool name can be inspected BEFORE any work happens, then hand
    // the parsed body to the transport (its handlePostMessage accepts one, so nothing is re-read).
    // The cheap-call meter already ran above, before the session lookup: previously only
    // `tools/call` was metered, and only after the whole body had been read and parsed — so
    // initialize/tools/list/ping and every notification were free, and the read itself was the
    // cheapest way to make the server do work.
    const MAX_BODY = 64 * 1024
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
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'could not read request body' }))
      }
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid JSON' }))
      return
    }

    const msg = parsed as { method?: string; params?: { name?: string } }
    if (msg.method === 'tools/call') {
      const tool = msg.params?.name ?? ''
      const expensive = EXPENSIVE_TOOLS.has(tool)
      const wait = limiter.check(
        `${expensive ? 'exp' : 'cheap'}:${ip}`,
        expensive ? LIMITS.expensiveCall : LIMITS.cheapCall,
      )
      if (wait !== null) {
        tooMany(res, wait, `rate limit for ${expensive ? 'sweep' : 'read'} tools`)
        return
      }
    }

    await transport.handlePostMessage(req, res, parsed)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({ error: 'not found', endpoints: ['/sse', '/messages', '/health', '/findings.json'] }),
  )
}

http.listen(PORT, HOST, () => {
  console.log(`ASSAY MCP (SSE) listening on http://${HOST}:${PORT}${PUBLIC_PATH}/sse`)
  if (PUBLIC_PATH) console.log(`clients are told to POST to ${PUBLIC_PATH}/messages`)
  console.log('tools: assay_true_position, assay_findings, assay_check_symbol')
})
