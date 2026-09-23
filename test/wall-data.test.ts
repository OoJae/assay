import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CITATION_RETENTION_MS,
  LIVE_REVALIDATE_SECONDS,
  LIVE_SNAPSHOT_URL,
  NAMED_INTEGRATOR_CLASS,
  SNAPSHOT_FRESH_MS,
  divergentTokens,
  forgetLiveBoard,
  isWithheldFindingId,
  loadSweep,
  loadSweepLive,
  publicOnly,
  snapshotAge,
  unreadAssets,
  type Finding,
  type SweepData,
} from '../web/lib/findings.js'
import { closureBasis, fmtAge, impactView, integratorView, listJoin, splitBySeverity } from '../web/lib/present.js'
import { PAID_ENDPOINTS as WEB_ENDPOINTS, PAY_TO as WEB_PAY_TO, curlFor } from '../web/lib/endpoints.js'
import { PAID_ENDPOINTS as SRC_ENDPOINTS, PAY_TO as SRC_PAY_TO } from '../src/lib/endpoints.js'
import { NAMED_INTEGRATOR_CLASS as SRC_NAMED_CLASS } from '../src/lib/redact.js'
import { feedForSymbol, type ChainlinkFeed } from '../src/lib/sources.js'
import { pricedSymbols, tickerOfFeed } from '../web/lib/feeds.js'
import { SERV_EXAMPLE, SERV_HARD, SERV_HELDOUT, SERV_INJECTION, SERV_SOURCES } from '../web/lib/serv-example.js'
import { WalletCheckError, checkWallet, fmtUnits, parseHolder, toView, type GuardReader } from '../web/lib/wallet-check.js'

/**
 * The wall's data layer, offline.
 *
 * web/ is a separate Vercel build with no tests of its own, and three production regressions are
 * recorded in its comments: the empty board on Vercel, the {available:false} empty board, and the
 * present-tense banner on a stale sweep. The one that mattered most had no comment at all: the
 * committed fallback carried 25 named-integrator rows for ten hours after the commit that withheld
 * them, and any non-200, 429, timeout or empty board would have rendered them next to "No contract
 * is named on this page". These import web/lib directly; nothing here touches the network.
 */

// Synthetic. A real named contract here would republish the name this file tests is withheld.
const ADDR = '0x1111111111111111111111111111111111111111'

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'CRWD-share-count',
    defectClass: 'SHARE_COUNT_MISREAD_RISK',
    severity: 'critical',
    subject: 'CRWD (0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931)',
    title: 'CRWD: reading balanceOf() as shares understates by 75.0000% (multiplier 4.000000000x)',
    statement: 's',
    impact: { basisPoints: 30000, percent: 75, note: 'n' },
    evidence: [],
    methodologyVersion: 'assay-rh-v0.3.0',
    detectedAt: '2026-09-22T11:06:19.000Z',
    verification: { checked: 2, reproduced: 2, mismatched: 0, pruned: 0, verifiedAt: '2026-09-22T11:06:20.000Z' },
    ...over,
  }
}

const named = (over: Partial<Finding> = {}) =>
  finding({
    id: `integrator-11111111-XYZ`,
    defectClass: NAMED_INTEGRATOR_CLASS,
    severity: 'low',
    subject: `${ADDR} (holds XYZ)`,
    title: '0x11111111… holds 100.0000 XYZ and cannot call uiMultiplier() directly',
    ...over,
  })

function board(over: Partial<SweepData> = {}): SweepData {
  return {
    blockNumber: '69605769',
    observedAt: '2026-09-22T11:06:19.000Z',
    assetsScanned: 195,
    feedsAvailable: 35,
    marketClosed: false,
    cohort: { size: 35, stale: 0, clockHint: false, read: 35, failed: 0, quorum: true },
    findings: [finding()],
    rejected: [],
    chainNotes: [],
    stats: {},
    errors: [],
    ...over,
  }
}

describe('publicOnly', () => {
  it('mirrors the class name in src/lib/redact.ts', () => {
    expect(NAMED_INTEGRATOR_CLASS).toBe(SRC_NAMED_CLASS)
  })

  it('strips named integrators from findings AND rejected, and counts them', () => {
    const d = publicOnly(
      board({
        findings: [finding(), named(), named({ id: 'integrator-11111111-ABC' })],
        rejected: [
          { reason: 'unchecked', detail: 'x', finding: { id: 'integrator-x', subject: ADDR, defectClass: NAMED_INTEGRATOR_CLASS } },
          { reason: 'mismatch', detail: 'y', finding: { id: 'SPY-share-count', subject: 'SPY (0x1)', defectClass: 'SHARE_COUNT_MISREAD_RISK' } },
        ],
      }),
    )
    expect(d.findings.map((f) => f.id)).toEqual(['CRWD-share-count'])
    expect(d.rejected.map((r) => r.finding.id)).toEqual(['SPY-share-count'])
    expect(d.withheld).toEqual({ namedIntegrators: 2, namedIntegratorsRejected: 1 })
    expect(JSON.stringify(d)).not.toContain(ADDR)
  })

  it('withholds a rejected row that cannot prove its class when its subject is a bare address', () => {
    const d = publicOnly(board({ rejected: [{ reason: 'unchecked', detail: 'x', finding: { id: 'i', subject: `${ADDR} (holds XYZ)` } }] }))
    expect(d.rejected).toEqual([])
  })

  it('adds to a count the sweep already recorded, and is idempotent', () => {
    const once = publicOnly(board({ findings: [finding(), named()], withheld: { namedIntegrators: 25, namedIntegratorsRejected: 0 } }))
    expect(once.withheld?.namedIntegrators).toBe(26)
    expect(publicOnly(once)).toEqual(once)
    // Nothing to strip: counts untouched.
    expect(publicOnly(board({ withheld: { namedIntegrators: 25 } })).withheld).toEqual({ namedIntegrators: 25 })
  })

  it("a named finding's id opens the withheld page, not the 404 that says nothing is hidden", () => {
    // Every id the detector gives the class, including the ones in the snapshot in git history.
    expect(isWithheldFindingId(named().id)).toBe(true)
    expect(isWithheldFindingId('integrator-0a0a0a0a-SGOV')).toBe(true)
    for (const id of ['CRWD-share-count', 'CRWD-stale-feed', 'integrator-x', 'integrators']) {
      expect([id, isWithheldFindingId(id)]).toEqual([id, false])
    }
  })
})

describe('loadSweep (the committed fallback)', () => {
  it('strips named rows from whatever file it finds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wall-'))
    const p = join(dir, 'findings.json')
    writeFileSync(p, JSON.stringify(board({ findings: [finding(), named()] })))
    const d = loadSweep([p])
    expect(d.findings.map((f) => f.defectClass)).toEqual(['SHARE_COUNT_MISREAD_RISK'])
    expect(d.source).toBe('committed')
    expect(d.withheld?.namedIntegrators).toBe(1)
  })

  it('returns an empty board, not a throw, when no file exists', () => {
    const d = loadSweep([join(tmpdir(), 'does-not-exist', 'findings.json')])
    expect(d.findings).toEqual([])
    expect(d.source).toBe('committed')
  })

  it('the committed boards, as loaded, name no integrator', () => {
    for (const p of ['data/findings.json', 'web/data/findings.json']) {
      const d = loadSweep([resolve(p)])
      expect(d.findings.length).toBeGreaterThan(0)
      const rows = [...d.findings, ...d.rejected.map((r) => r.finding)]
      expect(rows.filter((f) => f.defectClass === NAMED_INTEGRATOR_CLASS || f.subject.startsWith('0x'))).toEqual([])
    }
  })
})

describe('loadSweepLive', () => {
  const fallbackBoard = board({ findings: [finding({ id: 'FALLBACK' }), named()], observedAt: '2026-09-01T00:00:00.000Z' })
  const fallback = () => fallbackBoard
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    forgetLiveBoard()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const respond = (body: unknown, status = 200) =>
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))

  it('uses the live board, stripped, and reuses it for a minute without handing the fetch to Next\'s cache', async () => {
    respond(board({ findings: [finding({ id: 'LIVE' }), named()] }))
    const d = await loadSweepLive(fallback)
    expect(d.source).toBe('live')
    expect(d.findings.map((f) => f.id)).toEqual(['LIVE'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { next?: { revalidate?: number } }]
    expect(url).toBe(LIVE_SNAPSHOT_URL)
    // Next's data cache served a stale 200 forever and refetched without the timeout, so a dead
    // feed host never showed. Every real fetch is no-store and timed.
    expect(init.cache).toBe('no-store')
    expect(init.next).toBeUndefined()
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Reused inside the minute...
    expect((await loadSweepLive(fallback)).findings.map((f) => f.id)).toEqual(['LIVE'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('once the minute is up, a dead feed host shows as the fallback, not as the last live board', async () => {
    const t0 = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0)
    respond(board({ findings: [finding({ id: 'LIVE' })] }))
    expect((await loadSweepLive(fallback)).source).toBe('live')
    clock.mockReturnValue(t0 + LIVE_REVALIDATE_SECONDS * 1000)
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await fallsBack()
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[wall\] live feed unusable/))
  })

  const fallsBack = async () => {
    const d = await loadSweepLive(fallback)
    expect(d.source).toBe('committed')
    expect(d.findings.map((f) => f.id)).toEqual(['FALLBACK'])
    expect(JSON.stringify(d.findings)).not.toContain(ADDR)
  }

  it('falls back, stripped, on a 429 from the rate limiter', async () => {
    respond({ error: 'rate limited' }, 429)
    await fallsBack()
  })

  it('falls back on {available:false}', async () => {
    respond({ available: false, unavailableReason: 'no sweep artifact', findings: [] })
    await fallsBack()
  })

  it('falls back on an empty board, counted after redaction', async () => {
    respond(board({ findings: [named()] }))
    await fallsBack()
  })

  it('falls back on a timeout or network error', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
    await fallsBack()
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await fallsBack()
  })

  it('falls back on a 200 that is not a board', async () => {
    respond({ hello: 'world' })
    await fallsBack()
  })
})

describe('freshness', () => {
  const T = Date.parse('2026-09-22T12:00:00.000Z')
  it('is fresh for a healthy 8-minute sweep and stale after one missed publish', () => {
    expect(SNAPSHOT_FRESH_MS).toBe(20 * 60 * 1000)
    expect(snapshotAge(new Date(T - 14 * 60_000).toISOString(), T).fresh).toBe(true)
    expect(snapshotAge(new Date(T - 21 * 60_000).toISOString(), T).fresh).toBe(false)
    expect(snapshotAge(new Date(T - 2 * 3600_000).toISOString(), T).fresh).toBe(false)
  })
  it('never calls an unknown or future timestamp fresh', () => {
    expect(snapshotAge('not a date', T).fresh).toBe(false)
    expect(snapshotAge(new Date(T + 60_000).toISOString(), T).fresh).toBe(false)
  })
  it('keeps the citation retention at the measured low end', () => {
    expect(CITATION_RETENTION_MS).toBe(505_000)
  })
  it('formats ages without inventing one', () => {
    expect(fmtAge(new Date(T - 30_000).toISOString(), T)).toBe('30s ago')
    expect(fmtAge(new Date(T - 10 * 60_000).toISOString(), T)).toBe('10m ago')
    expect(fmtAge('garbage', T)).toBe('at an unknown time')
  })
})

describe('what the page derives from a board', () => {
  it('lists unread assets once each, so "assets read" is not the attempted count', () => {
    expect(unreadAssets(board({ errors: [{ symbol: 'CRWD', error: 'a' }, { symbol: 'CRWD', error: 'b' }, { symbol: 'AAPL', error: 'c' }] }))).toEqual(['AAPL', 'CRWD'])
    expect(unreadAssets(board())).toEqual([])
  })

  it('reads the divergent tokens and their contracts from the share-count rows', () => {
    const committed = loadSweep([resolve('web/data/findings.json')])
    const tokens = divergentTokens(committed)
    expect(tokens.length).toBe(committed.findings.filter((f) => f.defectClass === 'SHARE_COUNT_MISREAD_RISK').length)
    expect(tokens.find((t) => t.symbol === 'CRWD')?.token).toBe('0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931')
    expect(divergentTokens(board({ findings: [named()] }))).toEqual([])
  })

  it('leads with critical/high/medium and folds low and info under them', () => {
    const { lead, minor } = splitBySeverity([
      finding({ id: 'a', severity: 'low' }),
      finding({ id: 'b', severity: 'critical' }),
      finding({ id: 'c', severity: 'medium' }),
      finding({ id: 'd', severity: 'info' }),
    ])
    expect(lead.map((f) => f.id)).toEqual(['b', 'c'])
    expect(minor.map((f) => f.id)).toEqual(['a', 'd'])
  })

  it('says a closure is corroborated only when the cohort says so', () => {
    expect(closureBasis({ size: 35, read: 35, stale: 35, clockHint: true })).toBe('cohort')
    expect(closureBasis({ size: 35, read: 35, stale: 3, clockHint: true })).toBe('schedule')
    expect(closureBasis({ size: 35, read: 0, stale: 0, clockHint: true })).toBe('schedule')
  })
})

describe('impactView: one figure per finding', () => {
  it('shows only the percent for a pre-fix board, never "30,000 bps · 75%"', () => {
    const v = impactView(finding())
    expect(v.figure).toBe('75%')
    expect(v.measures).toMatch(/true share count/)
  })
  it('uses the finding’s own `measures` when present', () => {
    const v = impactView(finding({ impact: { basisPoints: 7500, percent: 75, measures: 'custom', note: 'n' } }))
    expect(v).toEqual({ figure: '75%', measures: 'custom' })
  })
  it('falls back to basis points only when there is no percent', () => {
    expect(impactView(finding({ defectClass: 'X', impact: { basisPoints: 1234, note: 'n' } }))).toEqual({ figure: '1,234 bps', measures: null })
    expect(impactView(finding({ impact: { note: 'n' } }))).toEqual({ figure: null, measures: null })
  })
})

describe('integratorView', () => {
  it('renders a pre-distinct board as holdings, not contracts', () => {
    const v = integratorView({ scanned: 96, contracts: 66, notAware: 25, aware: 0, proxyUnresolved: 2, usdHeldByNotAware: 2123776.9, sharesUnaccounted: 109.28 })
    expect(v.shape).toBe('pairs')
    if (v.shape === 'pairs') expect(v.holdings).toBe(66)
  })

  it('keeps NOT_APPLICABLE out of the NOT_AWARE figure and marks priced sums as floors', () => {
    const v = integratorView({
      scanned: 90,
      contracts: 40,
      notAware: 6,
      aware: 0,
      proxyUnresolved: 1,
      notApplicable: 10,
      tooSmall: 8,
      noHolding: 13,
      byRole: {
        AMM_POOL: { contracts: 7, usdHeld: 1_500_000 },
        AMM_POOL_MANAGER: { contracts: 1, usdHeld: 300_000 },
        CUSTODY: { contracts: 1, usdHeld: 0 },
        DISTRIBUTOR: { contracts: 1, usdHeld: 0 },
      },
      usdHeldByNotAware: 200_000,
      usdHeldByNotApplicable: 1_800_000,
      unpricedNotAware: 3,
      unpricedNotApplicable: 0,
      sharesUnaccounted: 12,
      minDivergence: 0.002,
      assetsScanned: ['CRWD', 'CCL'],
      assetsBelowCutoff: ['LLY'],
      assetsUnread: [],
    })
    expect(v.shape).toBe('distinct')
    if (v.shape !== 'distinct') return
    expect(v.resolved).toBe(39)
    expect(v.usdNotAware).toBe(200_000)
    expect(v.usdNotApplicable).toBe(1_800_000)
    expect(v.unpricedNotAware).toBe(3)
    // aware + unresolved + notAware + notApplicable + tooSmall + noHolding = 38 of 40: two had only unread balances.
    expect(v.unreadContracts).toBe(2)
    expect(v.notApplicableShare).toBeCloseTo(0.9)
    expect(v.roles.map((r) => `${r.contracts} ${r.label}`)).toEqual([
      '7 AMM pools',
      '1 pool manager',
      '1 custody or executor wallet',
      '1 distributor',
    ])
    expect(v.minDivergencePct).toBeCloseTo(0.2)
    expect(listJoin(['a', 'b', 'c'])).toBe('a, b and c')
  })
})

describe('prebuild.mjs', () => {
  const script = resolve('web/scripts/prebuild.mjs')

  function stage(withRoot: boolean, content: string) {
    const root = mkdtempSync(join(tmpdir(), 'prebuild-'))
    mkdirSync(join(root, 'web', 'data'), { recursive: true })
    if (withRoot) {
      mkdirSync(join(root, 'data'))
      writeFileSync(join(root, 'data', 'findings.json'), content)
    } else {
      writeFileSync(join(root, 'web', 'data', 'findings.json'), content)
    }
    execFileSync(process.execPath, [script], { cwd: join(root, 'web'), stdio: 'pipe' })
    return readFileSync(join(root, 'web', 'data', 'findings.json'), 'utf8')
  }

  it('never copies a named-integrator row into the bundle', () => {
    const out = JSON.parse(stage(true, JSON.stringify(board({ findings: [finding(), named()] }))))
    expect(out.findings.map((f: Finding) => f.defectClass)).toEqual(['SHARE_COUNT_MISREAD_RISK'])
    expect(out.withheld).toEqual({ namedIntegrators: 1, namedIntegratorsRejected: 0 })
  })

  it('filters the bundled copy in place when there is no repo-root artifact, as on Vercel', () => {
    const out = JSON.parse(stage(false, JSON.stringify(board({ rejected: [{ reason: 'unchecked', detail: 'x', finding: { id: 'i', subject: ADDR, defectClass: NAMED_INTEGRATOR_CLASS } }] }))))
    expect(out.rejected).toEqual([])
    expect(out.withheld.namedIntegratorsRejected).toBe(1)
  })

  it('copies a clean board byte-for-byte', () => {
    const text = readFileSync('data/findings.json', 'utf8')
    expect(stage(true, text)).toBe(text)
  })
})

describe('the wall’s copies of values owned by src/', () => {
  it('has the same paid endpoints as src/lib/endpoints.ts', () => {
    expect(WEB_PAY_TO).toBe(SRC_PAY_TO)
    for (const k of ['truePosition', 'checkContract'] as const) {
      const w = WEB_ENDPOINTS[k]
      const s = SRC_ENDPOINTS[k]
      expect({ capability: w.capability, priceUsd: w.priceUsd, trigger: w.trigger, paywall: w.paywall }).toEqual({
        capability: s.capability,
        priceUsd: s.priceUsd,
        trigger: s.trigger,
        paywall: s.paywall,
      })
      // Same body shape; the wall uses placeholders for every address.
      expect(Object.keys(w.exampleBody)).toEqual(Object.keys(s.exampleBody))
      expect(Object.keys(w.exampleBody.payload).sort()).toEqual(Object.keys(s.exampleBody.payload).sort())
      expect(JSON.stringify(w.exampleBody)).not.toMatch(/0x[0-9a-fA-F]{40}/)
    }
  })

  it('prints a five-line curl that carries the exact body', () => {
    const c = curlFor(WEB_ENDPOINTS.truePosition)
    expect(c.split('\n')).toHaveLength(5)
    expect(c).toContain(WEB_ENDPOINTS.truePosition.trigger)
    expect(c).toContain(JSON.stringify(WEB_ENDPOINTS.truePosition.exampleBody))
  })

  it('reads a feed name the way src/lib/sources.ts feedForSymbol does', () => {
    const names = ['Robinhood NVDA / USD', 'Robinhood SGOV-USD', 'Robinhood DELL-USD', 'BTC / USD', 'WSTETH / STETH Exchange Rate', 'Robinhood']
    const feeds = names.map((name) => ({ name, proxyAddress: '0x0', decimals: 8, heartbeat: 86400 })) as unknown as ChainlinkFeed[]
    const priced = pricedSymbols(feeds)
    expect(priced).toEqual(['DELL', 'NVDA', 'SGOV'])
    for (const sym of ['NVDA', 'SGOV', 'DELL', 'BTC', 'CRWD']) {
      expect(priced.includes(sym)).toBe(feedForSymbol(feeds, sym) !== null)
    }
    expect(tickerOfFeed(undefined)).toBeNull()
  })

  it('quotes SERV output verbatim from the committed artifacts', () => {
    for (const p of Object.values(SERV_SOURCES)) expect(existsSync(p)).toBe(true)
    const ab = JSON.parse(readFileSync(SERV_SOURCES.ab, 'utf8'))
    expect(ab.generatedAt).toBe(SERV_EXAMPLE.generatedAt)
    expect(ab.model).toBe(SERV_EXAMPLE.model)
    expect(ab.finding.id).toBe(SERV_EXAMPLE.findingId)
    expect(ab.finding.citations).toBe(SERV_EXAMPLE.citations)
    expect(ab.finding.evidence.map((e: { claim: string }) => e.claim)).toContain(SERV_EXAMPLE.evidenceClaim)
    expect(ab.mandate).toContain(SERV_EXAMPLE.mandateExcerpt)
    expect(ab.braidOn.verdict).toBe(SERV_EXAMPLE.verdict)
    expect(ab.braidOn.severity).toBe(SERV_EXAMPLE.severity)
    expect(ab.braidOn.rationale).toBe(SERV_EXAMPLE.rationale)
    expect(ab.unsafeVerdict).toBe(SERV_EXAMPLE.unsafeVerdict)
    expect(ab.inputHashes).toContain(SERV_EXAMPLE.inputHash)

    const inj = JSON.parse(readFileSync(SERV_SOURCES.injection, 'utf8')) as {
      payloads: string[]
      rows: Array<{ attempted: number; held: number; compromised: number; guardTriggered: number }>
    }
    const sum = (k: 'attempted' | 'held' | 'compromised' | 'guardTriggered') => inj.rows.reduce((n, r) => n + r[k], 0)
    expect({
      payloads: inj.payloads.length,
      calls: sum('attempted'),
      withheld: sum('held'),
      compromised: sum('compromised'),
      guardTriggered: sum('guardTriggered'),
    }).toEqual(SERV_INJECTION)

    const hard = JSON.parse(readFileSync(SERV_SOURCES.hard, 'utf8'))
    for (const arm of ['braidOn', 'braidOff']) {
      expect({ correct: hard.summary[arm].correct, attempted: hard.summary[arm].attempted }).toEqual(SERV_HARD)
    }

    const ho = JSON.parse(readFileSync(SERV_SOURCES.heldout, 'utf8'))
    const pct = (x: number) => Math.round(x * 100)
    expect(ho.kind).toBe('heldout-trials')
    expect(ho.summary.braidOff.headline.cases).toBe(SERV_HELDOUT.cases)
    expect({
      correct: ho.summary.braidOff.headline.correct,
      lowerPct: pct(ho.summary.braidOff.headline.wilson95.lower),
      upperPct: pct(ho.summary.braidOff.headline.wilson95.upper),
    }).toEqual(SERV_HELDOUT.braidOff)
    expect({
      correct: ho.summary.braidOn.headline.correct,
      refused: ho.summary.braidOn.perDraw.errored,
      calls: ho.summary.braidOn.perDraw.attempted,
    }).toEqual(SERV_HELDOUT.braidOn)
  })
})

describe('wallet check', () => {
  const T1 = { symbol: 'CRWD', token: '0x00000000000000000000000000000000000000c1' as const }
  const T2 = { symbol: 'CCL', token: '0x00000000000000000000000000000000000000c2' as const }
  const T3 = { symbol: 'UPS', token: '0x00000000000000000000000000000000000000c3' as const }
  const E18 = 10n ** 18n
  const HOLDER = '0x000000000000000000000000000000000000dEaD'

  function reader(over: Partial<GuardReader> = {}): GuardReader & { blocks: bigint[] } {
    const blocks: bigint[] = []
    return {
      blocks,
      blockNumber: async () => 100n,
      balanceOf: async (token, _h, b) => {
        blocks.push(b)
        if (token === T1.token) return 2n * E18
        if (token === T2.token) return 5n * E18
        return 0n
      },
      shareEquivalents: async (token, _h, b) => {
        blocks.push(b)
        return token === T1.token ? ([8n * E18, true, ''] as const) : ([0n, false, 'oraclePaused() is true'] as const)
      },
      decimals: async () => 18,
      ...over,
    }
  }

  it('reports raw balance, share-equivalents and refusals, all at one block', async () => {
    const r = reader()
    const res = await checkWallet(HOLDER, [T1, T2, T3], r)
    expect(res.blockNumber).toBe(100n)
    expect(new Set(r.blocks)).toEqual(new Set([100n]))
    expect(res.held.map((h) => [h.symbol, fmtUnits(h.balance, 18), h.shares === null ? null : fmtUnits(h.shares, 18), h.safe, h.reason])).toEqual([
      ['CRWD', '2', '8', true, null],
      ['CCL', '5', null, false, 'oraclePaused() is true'],
    ])
    expect(res.zero).toBe(1)
    expect(res.unread).toEqual([])
    // What the page renders: strings only, a refusal with no share figure.
    expect(toView(res).rows).toEqual([
      { symbol: 'CRWD', token: T1.token, balance: '2', shares: '8', safe: true, reason: null },
      { symbol: 'CCL', token: T2.token, balance: '5', shares: null, safe: false, reason: 'oraclePaused() is true' },
    ])
  })

  it('reports a failed balance read as unread, never as zero', async () => {
    const res = await checkWallet(HOLDER, [T1, T2, T3], reader({
      balanceOf: async (token) => {
        if (token === T3.token) throw new Error('HTTP 403')
        return 0n
      },
    }))
    expect(res.unread).toEqual(['UPS'])
    expect(res.zero).toBe(2)
  })

  it('says the RPC is down instead of "holds nothing" when every read fails', async () => {
    await expect(checkWallet(HOLDER, [T1, T2], reader({ balanceOf: async () => { throw new Error('Failed to fetch') } }))).rejects.toMatchObject({ kind: 'rpc_unavailable' })
    await expect(checkWallet(HOLDER, [T1], reader({ blockNumber: async () => { throw new Error('Failed to fetch') } }))).rejects.toBeInstanceOf(WalletCheckError)
  })

  it('keeps a held token whose guard call failed, with no share figure', async () => {
    const res = await checkWallet(HOLDER, [T1], reader({ shareEquivalents: async () => { throw new Error('execution reverted') } }))
    expect(res.held[0]).toMatchObject({ symbol: 'CRWD', shares: null, safe: null, reason: 'the guard call could not be read' })
  })

  it('validates the address before reading anything', async () => {
    const r = reader({ blockNumber: vi.fn(async () => 1n) })
    await expect(checkWallet('not an address', [T1], r)).rejects.toMatchObject({ kind: 'bad_address' })
    expect(r.blockNumber).not.toHaveBeenCalled()
    expect(parseHolder('0x000000000000000000000000000000000000dead')).toBe(HOLDER)
    expect(parseHolder('0X000000000000000000000000000000000000DEAD'.replace('0X', '0x'))).toBe(HOLDER)
    // One flipped case in a checksummed address fails EIP-55.
    expect(() => parseHolder('0x000000000000000000000000000000000000DeaD')).toThrow(/checksum/)
  })

  it('formats base units without rounding a tiny balance to zero', () => {
    expect(fmtUnits(3019601719008384247n, 18)).toBe('3.019601')
    expect(fmtUnits(15856305572n, 18)).toBe('<0.000001')
    expect(fmtUnits(0n, 18)).toBe('0')
    expect(fmtUnits(5n * E18, 18)).toBe('5')
  })
})
