import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { buildServer } from './server.js'
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
const HOST = process.env.MCP_HOST ?? '0.0.0.0'

/** One transport per connected client, routed by sessionId on the POST leg. */
const sessions = new Map<string, SSEServerTransport>()

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

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  cors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket.remoteAddress)

  if (req.method === 'GET' && url.pathname === '/health') {
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

  if (req.method === 'GET' && url.pathname === '/sse') {
    if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
      tooMany(res, 30, `server is at its ${MAX_CONCURRENT_SESSIONS}-session cap`)
      return
    }
    const wait = limiter.check(`conn:${ip}`, LIMITS.connection)
    if (wait !== null) {
      tooMany(res, wait, 'too many connections from this address')
      return
    }
    const transport = new SSEServerTransport('/messages', res)
    const server = buildServer()
    sessions.set(transport.sessionId, transport)
    // Drop the session when the client disconnects, or the map leaks one entry per connection.
    transport.onclose = () => sessions.delete(transport.sessionId)
    res.on('close', () => sessions.delete(transport.sessionId))
    await server.connect(transport)
    return
  }

  if (req.method === 'POST' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId')
    const transport = sessionId ? sessions.get(sessionId) : undefined
    if (!transport) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown or expired sessionId — reopen GET /sse' }))
      return
    }

    // Read the body ourselves so the tool name can be inspected BEFORE any work happens, then hand
    // the parsed body to the transport (its handlePostMessage accepts one, so nothing is re-read).
    const raw = await new Promise<string>((resolve, reject) => {
      let buf = ''
      req.on('data', (c) => {
        buf += c
        // Refuse absurd payloads rather than buffering them.
        if (buf.length > 1_000_000) reject(new Error('payload too large'))
      })
      req.on('end', () => resolve(buf))
      req.on('error', reject)
    }).catch(() => null)

    if (raw === null) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'payload too large' }))
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
  res.end(JSON.stringify({ error: 'not found', endpoints: ['/sse', '/messages', '/health'] }))
})

http.listen(PORT, HOST, () => {
  console.log(`ASSAY MCP (SSE) listening on http://${HOST}:${PORT}/sse`)
  console.log('tools: assay_true_position, assay_findings, assay_check_symbol')
})
