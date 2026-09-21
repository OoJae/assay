import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { buildServer } from './server.js'

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
 * Safe to run with NO secrets: every tool is a public Robinhood Chain read.
 */
const PORT = Number(process.env.MCP_PORT ?? 7379)
const HOST = process.env.MCP_HOST ?? '0.0.0.0'

/** One transport per connected client, routed by sessionId on the POST leg. */
const sessions = new Map<string, SSEServerTransport>()

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

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, transport: 'sse', sessions: sessions.size }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/sse') {
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
    await transport.handlePostMessage(req, res)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found', endpoints: ['/sse', '/messages', '/health'] }))
})

http.listen(PORT, HOST, () => {
  console.log(`ASSAY MCP (SSE) listening on http://${HOST}:${PORT}/sse`)
  console.log('tools: assay_true_position, assay_findings, assay_check_symbol')
})
