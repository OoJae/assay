import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { get, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

/**
 * The public MCP server, offline: what each free tool may return, and how the HTTP side holds up.
 *
 * The free tools served the same answers the two x402 endpoints sell — auditContract() with
 * holdings and dollars, TruePosition with the corrected figures — at 60 calls a minute. And the
 * transport let nine addresses hold every session slot with a ping every ten minutes, failed closed
 * for every new client once its limiter map filled, and published its session counts on /health.
 * The chain is never reached: the surface functions are mocked at their boundary, and the HTTP
 * tests run against a server on a loopback port.
 */

const T = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assay-mcp-test-${process.pid}-${Date.now()}`
  // Read by surface.ts at import, so it has to be set before anything imports it.
  process.env.ASSAY_FINDINGS_PATH = `${dir}/findings.json`
  return {
    dir,
    findings: `${dir}/findings.json`,
    status: `${dir}/sweep-status.json`,
    contractVerdict: vi.fn(),
    auditContract: vi.fn(),
    checkSymbol: vi.fn(),
    truePosition: vi.fn(),
    truePositionFor: vi.fn(),
  }
})

vi.mock('../src/lib/surface.js', async (orig) => ({
  ...(await orig<object>()),
  contractVerdict: T.contractVerdict,
  auditContract: T.auditContract,
  checkSymbol: T.checkSymbol,
  truePositionFor: T.truePositionFor,
}))
vi.mock('../src/lib/position.js', async (orig) => ({ ...(await orig<object>()), truePosition: T.truePosition }))

const { buildServer, publicText, publicError, sweepHealth, DISCLAIMER } = await import('../src/mcp/server.js')
const { createMcpHttp, MAX_SESSIONS_PER_IP, SESSION_EVICTABLE_MS, SESSION_MAX_MS } = await import('../src/mcp/sse.js')
const { PAID_ENDPOINTS } = await import('../src/lib/endpoints.js')

const HOLDER = '0x1111111111111111111111111111111111111111'
const CONTRACT = '0x2222222222222222222222222222222222222222'
const NAMED = '0x3333333333333333333333333333333333333333'

/** A TruePosition whose every figure is distinctive, so a leak of any one of them is findable in text. */
const POSITION = {
  symbol: 'CRWD',
  token: '0x4444444444444444444444444444444444444444',
  holder: HOLDER,
  rawBalance: '123456789000000000000',
  tokenDecimals: 18,
  uiMultiplier: '4000000000000000000',
  multiplier: 4,
  shareEquivalents: 493.827156,
  tokenUnits: 123.456789,
  tokenPriceUsd: 77.7731,
  underlyingSharePriceUsd: 19.443275,
  positionValueUsd: 9601.4567,
  feed: '0x5555555555555555555555555555555555555555',
  feedAgeSeconds: 120,
  feedHeartbeat: 86400,
  feedStale: false,
  oraclePaused: false,
  checks: { pauseChecked: true, feedRead: true, priceSane: true, roundComplete: true, multiplierSane: true },
  pending: { checked: true, newUIMultiplier: null, newMultiplier: null, effectiveAt: null, secondsUntilEffective: null },
  warning: null,
  blockNumber: '70000000',
  observedAt: '2026-09-23T00:00:00.000Z',
  refusalReason: null,
  confidence: 'high',
}
const POSITION_FIGURES = ['123456789000000000000', '493.827', '123.456', '77.773', '19.443', '9601.45']

const VERDICT = {
  address: CONTRACT,
  blockNumber: '70000000',
  observedAt: '2026-09-23T00:00:00.000Z',
  verdict: 'NOT_APPLICABLE',
  role: 'AMM_POOL',
  codeHash: '0x' + 'ab'.repeat(32),
  conclusive: true,
  interpretation: 'Recognised by the functions it implements (slot0(), swap(...)) as an AMM pool.',
  fullAudit: {
    priceUsd: PAID_ENDPOINTS.checkContract.priceUsd,
    x402: PAID_ENDPOINTS.checkContract.trigger,
    paywall: PAID_ENDPOINTS.checkContract.paywall,
    note: 'see the paid audit',
  },
}

const finding = (id: string, defectClass: string, subject: string) => ({
  id,
  defectClass,
  severity: 'high',
  subject,
  title: id,
  statement: id,
  affectedParty: 'x',
  evidence: [],
  verification: { reproduced: 1, checked: 1 },
})

let writes = 0
function writeBoard(opts: { observedAt: string; status?: object | null; named?: boolean }) {
  mkdirSync(T.dir, { recursive: true })
  // A different size on every write: loadSnapshot's cache is keyed on mtime and size, and two
  // same-size writes inside one timestamp tick would read back the previous board.
  writes++
  const board = {
    pad: 'x'.repeat(writes),
    blockNumber: '70000000',
    observedAt: opts.observedAt,
    findings: [
      finding('share-CRWD', 'SHARE_COUNT_MISREAD_RISK', 'CRWD (0x44…)'),
      ...(opts.named ? [finding(`integrator-${NAMED.slice(2, 10)}-CRWD`, 'INTEGRATOR_NOT_MULTIPLIER_AWARE', `${NAMED} (holds CRWD)`)] : []),
    ],
    rejected: opts.named
      ? [{ reason: 'mismatch', detail: 'x', finding: finding('rej', 'INTEGRATOR_NOT_MULTIPLIER_AWARE', `${NAMED} (holds UPS)`) }]
      : [],
    withheld: { namedIntegrators: 25, namedIntegratorsRejected: 0 },
  }
  writeFileSync(T.findings, JSON.stringify(board))
  if (opts.status === null) rmSync(T.status, { force: true })
  else if (opts.status) writeFileSync(T.status, JSON.stringify(opts.status))
}

const PUBLISHED = (at: string) => ({
  lastRunAt: at,
  outcome: 'published',
  reason: 'healthy: 0/195 assets unread, cohort 35/35 read',
  published: 45,
  errors: 0,
  assetsScanned: 195,
  block: '70000000',
})
const REFUSED = (at: string) => ({
  lastRunAt: at,
  outcome: 'refused',
  reason:
    'sweep failed before producing a board: ENOENT: no such file, open ' +
    "'/home/ubuntu/assay-data/x.json'\nURL: https://rpc.example/secret-key",
  published: 0,
  errors: 0,
  assetsScanned: 0,
  block: null,
})

async function connect() {
  const server = buildServer()
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> }
  const text = r.content[0]!.text
  return { isError: r.isError, text, body: JSON.parse(text) as Record<string, any> }
}

beforeAll(() => {
  writeBoard({ observedAt: new Date().toISOString(), status: PUBLISHED(new Date().toISOString()) })
})
afterAll(() => rmSync(T.dir, { recursive: true, force: true }))

beforeEach(() => {
  for (const m of [T.contractVerdict, T.auditContract, T.checkSymbol, T.truePosition, T.truePositionFor]) m.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('free verdicts: the MCP tools return no paid figures', () => {
  it('assay_check_contract returns the verdict and a pointer to the $0.25 audit, never the audit', async () => {
    T.contractVerdict.mockResolvedValue(VERDICT)
    T.auditContract.mockResolvedValue({ holdings: [{ symbol: 'CRWD', usdHeld: 9601.45 }], totalUsdHeld: 9601.45 })
    const { isError, body, text } = await call(await connect(), 'assay_check_contract', { address: CONTRACT })

    expect(isError).toBe(false)
    expect(T.auditContract).not.toHaveBeenCalled()
    expect(T.contractVerdict).toHaveBeenCalledWith(CONTRACT)
    expect(Object.keys(body).sort()).toEqual(
      ['address', 'blockNumber', 'codeHash', 'conclusive', 'disclaimer', 'fullAudit', 'interpretation', 'observedAt', 'role', 'verdict'].sort(),
    )
    expect(body).toMatchObject({ verdict: 'NOT_APPLICABLE', role: 'AMM_POOL', conclusive: true })
    expect(body.fullAudit.x402).toBe(PAID_ENDPOINTS.checkContract.trigger)
    for (const k of ['holdings', 'totalUsdHeld', 'pricedUsdHeld', 'evidence', 'incomplete', 'unpricedSymbols']) {
      expect(body).not.toHaveProperty(k)
    }
    expect(text).not.toContain('9601')
  })

  it('an unresolved proxy is still an error to the caller, not a pass', async () => {
    T.contractVerdict.mockResolvedValue({ ...VERDICT, verdict: 'PROXY_UNRESOLVED', role: undefined, conclusive: false })
    const { isError } = await call(await connect(), 'assay_check_contract', { address: CONTRACT })
    expect(isError).toBe(true)
  })

  it('assay_true_position returns the confidence and its reasons, not the position', async () => {
    T.truePosition.mockResolvedValue({ ...POSITION, warning: 'CRWD has a multiplier change scheduled at 2026-09-23T01:00:00.000Z.' })
    const { isError, body, text } = await call(await connect(), 'assay_true_position', { symbol: 'CRWD', holder: HOLDER })

    expect(isError).toBe(false)
    expect(T.truePositionFor).not.toHaveBeenCalled()
    expect(body).toMatchObject({ symbol: 'CRWD', holder: HOLDER, confidence: 'high', refusalReason: null, blockNumber: '70000000' })
    expect(body.checks).toEqual(POSITION.checks)
    expect(body.warning).toMatch(/multiplier change scheduled/)
    expect(body.fullAnswer.x402).toBe(PAID_ENDPOINTS.truePosition.trigger)
    expect(body.disclaimer).toBe(DISCLAIMER)
    for (const k of ['rawBalance', 'tokenUnits', 'shareEquivalents', 'tokenPriceUsd', 'underlyingSharePriceUsd', 'positionValueUsd', 'uiMultiplier']) {
      expect(body).not.toHaveProperty(k)
    }
    for (const figure of POSITION_FIGURES) expect(text).not.toContain(figure)
  })

  it('a refusal is served free, with its reason', async () => {
    T.truePosition.mockResolvedValue({
      ...POSITION,
      confidence: 'refuse',
      refusalReason: 'oraclePaused() is true for this token; price must not be trusted.',
    })
    const { isError, body, text } = await call(await connect(), 'assay_true_position', { symbol: 'CRWD', holder: HOLDER })
    expect(isError).toBe(false)
    expect(body).toMatchObject({ confidence: 'refuse', refusalReason: expect.stringMatching(/oraclePaused/) })
    for (const figure of POSITION_FIGURES) expect(text).not.toContain(figure)
  })

  it('assay_check_symbol never returns a named-integrator row, even if one reaches it', async () => {
    T.checkSymbol.mockResolvedValue({
      symbol: 'CRWD',
      assessed: true,
      published: 1,
      errors: [],
      findings: [
        finding('share-CRWD', 'SHARE_COUNT_MISREAD_RISK', 'CRWD (0x44…)'),
        finding('integrator-33333333-CRWD', 'INTEGRATOR_NOT_MULTIPLIER_AWARE', `${NAMED} (holds CRWD)`),
      ],
    })
    const { body, text } = await call(await connect(), 'assay_check_symbol', { symbol: 'CRWD' })
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual(['share-CRWD'])
    expect(text).not.toContain(NAMED.slice(2, 10))
    expect(text).not.toContain('INTEGRATOR_NOT_MULTIPLIER_AWARE')
  })

  it('the descriptions say what is free, what the paid endpoint adds, and where it is', async () => {
    const { tools } = await (await connect()).listTools()
    const d = Object.fromEntries(tools.map((t) => [t.name, t.description ?? '']))
    expect(Object.keys(d).sort()).toEqual(['assay_check_contract', 'assay_check_symbol', 'assay_findings', 'assay_true_position'])
    expect(d.assay_check_contract).toMatch(/FREE VERDICT ONLY/)
    expect(d.assay_check_contract).toContain(PAID_ENDPOINTS.checkContract.trigger)
    expect(d.assay_check_contract).toMatch(/NOT_APPLICABLE/)
    expect(d.assay_true_position).toMatch(/FREE VERDICT ONLY/)
    expect(d.assay_true_position).toContain(PAID_ENDPOINTS.truePosition.trigger)
    // The measured figure, not the old "roughly half an hour".
    expect(d.assay_findings).not.toMatch(/half an hour|30 minutes/)
    expect(d.assay_findings).toMatch(/8-17 minutes/)
    for (const text of Object.values(d)) expect(text).toMatch(/not affiliated with Robinhood/)
  })
})

describe('heavy tools share one process-wide in-flight cap', () => {
  it('answers a call over the cap with a busy error, then admits calls once slots free', async () => {
    const pending: Array<() => void> = []
    T.checkSymbol.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve({ symbol: 'CRWD', assessed: true, findings: [] }))),
    )
    // Two sessions, as two callers would have: the cap is the process's, not the session's.
    const [a, b] = [await connect(), await connect()]
    const first = call(a, 'assay_check_symbol', { symbol: 'CRWD' })
    const second = call(b, 'assay_check_symbol', { symbol: 'CRWD' })
    await vi.waitFor(() => expect(T.checkSymbol).toHaveBeenCalledTimes(2))

    const third = await call(b, 'assay_check_symbol', { symbol: 'CRWD' })
    expect(third.isError).toBe(true)
    expect(third.body).toMatchObject({ error: 'busy', retryable: true })
    expect(T.checkSymbol).toHaveBeenCalledTimes(2)

    for (const done of pending.splice(0)) done()
    expect((await first).isError).toBe(false)
    expect((await second).isError).toBe(false)

    T.checkSymbol.mockResolvedValue({ symbol: 'CRWD', assessed: true, findings: [] })
    expect((await call(a, 'assay_check_symbol', { symbol: 'CRWD' })).isError).toBe(false)
  })

  it('a call that throws gives its slot back', async () => {
    T.contractVerdict.mockRejectedValue(new Error('boom'))
    const client = await connect()
    for (let i = 0; i < 6; i++) {
      const r = await call(client, 'assay_check_contract', { address: CONTRACT })
      expect(r.body.error).not.toBe('busy')
    }
  })
})

describe('errors returned to callers', () => {
  const viem403 = Object.assign(
    new Error(
      'HTTP request failed.\n\nStatus: 403\nURL: https://rpc.mainnet.chain.robinhood.com/\n' +
        'Request body: {"method":"eth_getCode"}\n\nDetails: "<!DOCTYPE html><title>Just a moment...</title>"\nVersion: viem@2.56.8',
    ),
    { name: 'HttpRequestError', status: 403 },
  )

  it('a failed chain read says retry, without the upstream body or URL', async () => {
    T.contractVerdict.mockRejectedValue(viem403)
    const { isError, body, text } = await call(await connect(), 'assay_check_contract', { address: CONTRACT })
    expect(isError).toBe(true)
    expect(body).toMatchObject({ retryable: true, ref: expect.stringMatching(/^[0-9a-f]{8}$/) })
    for (const leak of ['DOCTYPE', 'Request body', 'rpc.mainnet', 'viem@', 'eth_getCode']) expect(text).not.toContain(leak)
  })

  it('an unexpected error names no internal path', async () => {
    T.contractVerdict.mockRejectedValue(new Error("ENOENT: no such file or directory, open '/home/ubuntu/assay-data/x.json'"))
    const { body, text } = await call(await connect(), 'assay_check_contract', { address: CONTRACT })
    expect(body).toMatchObject({ error: 'Internal error; nothing was concluded.', retryable: false })
    expect(text).not.toContain('/home/ubuntu')
  })

  it('a mistyped ticker still gets its did-you-mean, because that message is about the input', async () => {
    T.truePosition.mockRejectedValue(new Error('unknown Robinhood Stock Token symbol: CRWDD — did you mean CRWD?'))
    const { isError, body } = await call(await connect(), 'assay_true_position', { symbol: 'CRWDD', holder: HOLDER })
    expect(isError).toBe(true)
    expect(body.error).toBe('unknown Robinhood Stock Token symbol: CRWDD — did you mean CRWD?')
  })

  it('a getCode failure in the verdict reads as retryable, as the paid agent maps it', () => {
    expect(publicError(new Error(`could not read code at ${CONTRACT}`)).retryable).toBe(true)
  })

  it('publicText keeps the first line and drops paths', () => {
    expect(publicText('HTTP request failed.\n\nURL: https://x/\nRequest body: {}')).toBe('HTTP request failed.')
    expect(publicText("open '/home/ubuntu/assay-data/findings.json' failed")).toBe("open '<path>' failed")
    expect(publicText('x'.repeat(500)).length).toBeLessThanOrEqual(240)
  })
})

describe('assay_findings and sweep health', () => {
  it('says whether the sweep is publishing, and counts withheld names from the board', async () => {
    const now = new Date().toISOString()
    writeBoard({ observedAt: now, status: PUBLISHED(now) })
    const { body } = await call(await connect(), 'assay_findings', {})
    expect(body.sweepHealth).toMatchObject({ healthy: true, problems: [], lastRun: { outcome: 'published' } })
    // The board on disk is redacted, so subtracting finding counts gives 0; the sweep's count is 25.
    expect(body.namedIntegratorsWithheld).toBe(25)
    expect(body.disclaimer).toBe(DISCLAIMER)
  })

  it('a refusing sweep is visible, with its reason cleaned of paths and upstream detail', async () => {
    const now = new Date().toISOString()
    writeBoard({ observedAt: now, status: REFUSED(now) })
    const { body, text } = await call(await connect(), 'assay_findings', {})
    expect(body.available).toBe(true)
    expect(body.sweepHealth.healthy).toBe(false)
    expect(body.sweepHealth.problems.join(' ')).toMatch(/refused to publish/)
    expect(text).not.toContain('/home/ubuntu')
    expect(text).not.toContain('secret-key')
  })

  it('a missing board says so without naming its path on this host', async () => {
    rmSync(T.findings, { force: true })
    const { body, text } = await call(await connect(), 'assay_findings', {})
    expect(body.available).toBe(false)
    expect(body.unavailableReason).toBe('no sweep artifact has been published on this host')
    expect(text).not.toContain(T.dir)
    writeBoard({ observedAt: new Date().toISOString(), status: PUBLISHED(new Date().toISOString()) })
  })

  it('a board past 20 minutes is stale even when the last run published', () => {
    const now = Date.parse('2026-09-23T01:00:00Z')
    const h = sweepHealth(
      { findings: [], available: true, observedAt: '2026-09-23T00:30:00Z', blockNumber: '1' },
      PUBLISHED('2026-09-23T00:31:00Z') as never,
      now,
    )
    expect(h.healthy).toBe(false)
    expect(h.boardAgeSeconds).toBe(1800)
    expect(h.problems[0]).toMatch(/30 minutes old/)
  })
})

// ---------------------------------------------------------------------------------------------
// The HTTP side, on a loopback port.
// ---------------------------------------------------------------------------------------------

type App = ReturnType<typeof createMcpHttp>

async function start(opts: Parameters<typeof createMcpHttp>[0] = {}): Promise<{ app: App; base: string; port: number }> {
  const app = createMcpHttp({ publicPath: '', findingsPath: T.findings, ...opts })
  await new Promise<void>((r) => app.http.listen(0, '127.0.0.1', r))
  const port = (app.http.address() as AddressInfo).port
  return { app, base: `http://127.0.0.1:${port}`, port }
}

interface Stream {
  status: number
  sessionId: string
  text: () => string
  ended: Promise<void>
  close: () => void
}

/** Open GET /sse and wait for the endpoint event (or a refusal). */
function openStream(port: number, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let buf = ''
    let endedResolve: () => void
    const ended = new Promise<void>((r) => (endedResolve = r))
    const req = get({ host: '127.0.0.1', port, path: '/sse', headers }, (res: IncomingMessage) => {
      res.setEncoding('utf8')
      res.on('end', () => endedResolve())
      res.on('close', () => endedResolve())
      const done = (sessionId: string) =>
        resolve({ status: res.statusCode ?? 0, sessionId, text: () => buf, ended, close: () => req.destroy() })
      if (res.statusCode !== 200) {
        res.on('data', (c: string) => (buf += c))
        res.on('end', () => done(''))
        return
      }
      res.on('data', (c: string) => {
        buf += c
        const m = buf.match(/sessionId=([0-9a-f-]+)/)
        if (m) done(m[1]!)
      })
    })
    req.on('error', reject)
  })
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })

describe('HTTP: health and the public feed', () => {
  let s: Awaited<ReturnType<typeof start>>
  afterEach(() => s?.app.close())

  it('/health says the process is up and how the sweep is doing, and no session counts', async () => {
    const now = new Date().toISOString()
    writeBoard({ observedAt: now, status: PUBLISHED(now) })
    s = await start()
    const res = await fetch(`${s.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(Object.keys(body).sort()).toEqual(['ok', 'sweep', 'transports'])
    expect(body.ok).toBe(true)
    expect(body.transports).toEqual({ sse: '/sse', streamableHttp: '/mcp' })
    expect(Object.keys(body.sweep).sort()).toEqual(
      ['boardAgeSeconds', 'boardBlock', 'boardObservedAt', 'cadenceSeconds', 'healthy', 'lastRun', 'problems', 'staleAfterSeconds'].sort(),
    )
    expect(body.sweep.lastRun).toMatchObject({ outcome: 'published', published: 45, ageSeconds: expect.any(Number) })
    for (const k of ['sessions', 'maxSessions', 'trackedClients']) expect(JSON.stringify(body)).not.toContain(k)
    expect((await fetch(`${s.base}/health/sweep`)).status).toBe(200)
  })

  it('/health/sweep answers 503 when the last run refused, while /health stays 200', async () => {
    const now = new Date().toISOString()
    writeBoard({ observedAt: now, status: REFUSED(now) })
    s = await start()
    const strict = await fetch(`${s.base}/health/sweep`)
    expect(strict.status).toBe(503)
    expect(((await strict.json()) as { ok: boolean }).ok).toBe(false)
    expect((await fetch(`${s.base}/health`)).status).toBe(200)
  })

  it('/health/sweep answers 503 for a board nobody has refreshed', async () => {
    writeBoard({ observedAt: new Date(Date.now() - 3_600_000).toISOString(), status: null })
    s = await start()
    const res = await fetch(`${s.base}/health/sweep`)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { sweep: { problems: string[]; lastRun: unknown } }
    expect(body.sweep.lastRun).toBeNull()
    expect(body.sweep.problems[0]).toMatch(/60 minutes old/)
  })

  it('/findings.json strips named rows from findings AND rejected, and carries freshness', async () => {
    const now = new Date().toISOString()
    writeBoard({ observedAt: now, status: REFUSED(now), named: true })
    s = await start()
    const text = await (await fetch(`${s.base}/findings.json`)).text()
    const body = JSON.parse(text) as Record<string, any>
    expect(text).not.toContain(NAMED.slice(2, 10))
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual(['share-CRWD'])
    expect(body.rejected).toEqual([])
    expect(body.withheld).toEqual({ namedIntegrators: 25, namedIntegratorsRejected: 0 })
    // A refusal is stated, never turned into available:false (the wall would drop to its build copy).
    expect(body.available).toBe(true)
    expect(body.sweepHealth.healthy).toBe(false)
    expect(body.snapshotAgeSeconds).toBeGreaterThanOrEqual(0)
    expect(body.disclaimer).toBe(DISCLAIMER)
  })

  it('a CORS preflight allows the headers the SDK client sends after initialize', async () => {
    s = await start()
    const res = await fetch(`${s.base}/messages`, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com', 'access-control-request-headers': 'content-type,mcp-protocol-version' },
    })
    expect(res.status).toBe(204)
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').split(/,\s*/)
    expect(allowed).toEqual(expect.arrayContaining(['content-type', 'mcp-protocol-version', 'mcp-session-id']))
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('the 404 lists endpoints with the public prefix', async () => {
    s = await start({ publicPath: '/assay-mcp' })
    const body = (await (await fetch(`${s.base}/nope`)).json()) as { endpoints: string[] }
    expect(body.endpoints).toContain('/assay-mcp/mcp')
    expect(body.endpoints.every((e) => e.startsWith('/assay-mcp/'))).toBe(true)
  })
})

describe('HTTP: Streamable HTTP beside SSE', () => {
  let s: Awaited<ReturnType<typeof start>>
  afterEach(() => s?.app.close())

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  }

  it('POST /mcp initializes and lists the four tools, statelessly', async () => {
    s = await start()
    const init = await post(s.base, '/mcp', initialize)
    expect(init.status).toBe(200)
    expect(init.headers.get('mcp-session-id')).toBeNull()
    expect(((await init.json()) as any).result.serverInfo.name).toBe('assay')
    const list = await post(s.base, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = ((await list.json()) as any).result.tools.map((t: { name: string }) => t.name)
    expect(names).toHaveLength(4)
  })

  it('meters check_contract on /mcp in its own bucket', async () => {
    T.contractVerdict.mockResolvedValue(VERDICT)
    s = await start()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const r = await post(s.base, '/mcp', {
        jsonrpc: '2.0',
        id: i,
        method: 'tools/call',
        params: { name: 'assay_check_contract', arguments: { address: CONTRACT } },
      })
      statuses.push(r.status)
      await r.arrayBuffer()
    }
    expect(statuses.slice(0, 10).every((x) => x === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
  })

  it("one address cannot hold every sweep slot: its second concurrent check_symbol is busy, another address's is not", async () => {
    const pending: Array<() => void> = []
    T.checkSymbol.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve({ symbol: 'CRWD', assessed: true, findings: [] }))),
    )
    s = await start({ trusted: new Set(['127.0.0.1']) })
    const sweepFrom = (ip: string, id: number) =>
      post(
        s.base,
        '/mcp',
        { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'assay_check_symbol', arguments: { symbol: 'CRWD' } } },
        { 'x-forwarded-for': ip },
      )
    const first = sweepFrom('198.51.100.7', 1)
    await vi.waitFor(() => expect(T.checkSymbol).toHaveBeenCalledTimes(1))

    const again = (await (await sweepFrom('198.51.100.7', 2)).json()) as { result: { isError: boolean; content: Array<{ text: string }> } }
    expect(again.result.isError).toBe(true)
    expect(JSON.parse(again.result.content[0]!.text)).toMatchObject({ error: 'busy', retryable: true })
    expect(again.result.content[0]!.text).toMatch(/from your address/)

    const other = sweepFrom('198.51.100.8', 3)
    await vi.waitFor(() => expect(T.checkSymbol).toHaveBeenCalledTimes(2))
    for (const done of pending.splice(0)) done()
    for (const r of [await first, await other]) {
      const body = (await r.json()) as { result: { isError: boolean } }
      expect(body.result.isError).toBe(false)
    }
  })

  it('GET /mcp and POST /sse answer 405 and say where to go', async () => {
    s = await start()
    expect((await fetch(`${s.base}/mcp`)).status).toBe(405)
    const legacy = await post(s.base, '/sse', initialize)
    expect(legacy.status).toBe(405)
    expect(((await legacy.json()) as { error: string }).error).toMatch(/POST JSON-RPC to \/mcp/)
  })
})

describe('HTTP: SSE sessions are bounded', () => {
  let s: Awaited<ReturnType<typeof start>>
  const streams: Stream[] = []
  afterEach(() => {
    for (const st of streams.splice(0)) st.close()
    s?.app.close()
  })

  it(`holds at most ${MAX_SESSIONS_PER_IP} per address, and a new one displaces only an idle one of its own`, async () => {
    let clock = 1_000_000
    s = await start({ heartbeatMs: 0, now: () => clock })
    const mine: Stream[] = []
    for (let i = 0; i < MAX_SESSIONS_PER_IP; i++) mine.push(await openStream(s.port))
    streams.push(...mine)
    expect(s.app.sessionCount()).toBe(MAX_SESSIONS_PER_IP)

    // Every stream is in use: the new one is refused, and nobody is cut off.
    const refused = await openStream(s.port)
    expect(refused.status).toBe(429)
    expect(s.app.sessionCount()).toBe(MAX_SESSIONS_PER_IP)

    // The first makes a tool call just before the window closes, so the idlest is the second.
    clock += SESSION_EVICTABLE_MS - 1_000
    const tool = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'assay_findings', arguments: {} } }
    expect((await post(s.base, `/messages?sessionId=${mine[0]!.sessionId}`, tool)).status).toBe(202)
    clock += 1_000
    const next = await openStream(s.port)
    streams.push(next)
    expect(next.status).toBe(200)
    await mine[1]!.ended
    expect(s.app.sessionCount()).toBe(MAX_SESSIONS_PER_IP)

    const ping = { jsonrpc: '2.0', id: 2, method: 'ping' }
    expect((await post(s.base, `/messages?sessionId=${mine[1]!.sessionId}`, ping)).status).toBe(404)
    expect((await post(s.base, `/messages?sessionId=${mine[0]!.sessionId}`, ping)).status).toBe(202)
  })

  it('clients sharing one address do not evict each other into a reconnect loop', async () => {
    // The shape of OpenServ's platform or any NAT: several SDK clients, one egress IP. The SDK's
    // SSE client reconnects when its stream closes, so with 2 per address and evict-the-oldest,
    // three of them evicted each other without end and a tool call on an evicted session got 404.
    s = await start({ heartbeatMs: 0 })
    let opens = 0
    s.app.http.on('request', (req: IncomingMessage) => {
      if (req.method === 'GET' && req.url?.startsWith('/sse')) opens++
    })
    const clients: Client[] = []
    try {
      for (let i = 0; i < 3; i++) {
        const c = new Client({ name: `c${i}`, version: '1' })
        await c.connect(new SSEClientTransport(new URL(`${s.base}/sse`)))
        clients.push(c)
      }
      expect(s.app.sessionCount()).toBe(3)
      await new Promise((r) => setTimeout(r, 300))
      for (const c of clients) expect((await c.listTools()).tools.length).toBe(4)
      expect(opens).toBe(3)
      expect(s.app.sessionCount()).toBe(3)
    } finally {
      for (const c of clients) await c.close()
    }
  })

  it('refuses a new address once the global cap is reached, and cannot evict another address', async () => {
    s = await start({ heartbeatMs: 0, maxSessions: 2, trusted: new Set(['127.0.0.1']) })
    const a = await openStream(s.port, { 'x-forwarded-for': '198.51.100.1' })
    const b = await openStream(s.port, { 'x-forwarded-for': '198.51.100.2' })
    streams.push(a, b)
    const c = await openStream(s.port, { 'x-forwarded-for': '198.51.100.3' })
    expect(c.status).toBe(429)
    expect(c.text()).not.toMatch(/\d+-session/)
    expect(s.app.sessionCount()).toBe(2)
  })

  it(`closes a session at its absolute lifetime, however busy`, async () => {
    let clock = 1_000_000
    s = await start({ heartbeatMs: 0, now: () => clock })
    const st = await openStream(s.port)
    streams.push(st)
    for (const at of [SESSION_MAX_MS / 3, (2 * SESSION_MAX_MS) / 3, SESSION_MAX_MS - 1]) {
      clock = 1_000_000 + at
      const r = await post(s.base, `/messages?sessionId=${st.sessionId}`, {
        jsonrpc: '2.0',
        id: at,
        method: 'tools/call',
        params: { name: 'assay_findings', arguments: { limit: 1 } },
      })
      expect(r.status).toBe(202)
      expect(s.app.reap(clock)).toBe(0)
    }
    expect(s.app.reap(1_000_000 + SESSION_MAX_MS)).toBe(1)
    await st.ended
    expect(s.app.sessionCount()).toBe(0)
  })

  it('only a tool call keeps a session from going idle; a ping does not', async () => {
    let clock = 0
    s = await start({ heartbeatMs: 0, sessionIdleMs: 1_000, now: () => clock })
    const pinged = await openStream(s.port)
    const used = await openStream(s.port)
    streams.push(pinged, used)

    clock = 900
    expect((await post(s.base, `/messages?sessionId=${pinged.sessionId}`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(202)
    const tool = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'assay_findings', arguments: {} } }
    expect((await post(s.base, `/messages?sessionId=${used.sessionId}`, tool)).status).toBe(202)

    expect(s.app.reap(1_000)).toBe(1)
    await pinged.ended
    expect(s.app.sessionCount()).toBe(1)
    expect(s.app.reap(1_899)).toBe(0)
    expect(s.app.reap(1_900)).toBe(1)
  })

  it('writes an SSE heartbeat comment on an idle stream', async () => {
    s = await start({ heartbeatMs: 20 })
    const st = await openStream(s.port)
    streams.push(st)
    await vi.waitFor(() => expect(st.text()).toMatch(/\n: ping\n\n/), { timeout: 2_000 })
  })
})
