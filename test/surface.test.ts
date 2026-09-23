import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encodeAbiParameters, toFunctionSelector } from 'viem'

/**
 * The public and paid surfaces, offline.
 *
 * What is under test is where each answer may go. The free MCP tools returned the same thing the
 * x402 endpoints sell, and assay_check_symbol returned every named integrator for a ticker while
 * the wall withheld the class. And the $0.25 audit reported a failed read as "holds nothing" and an
 * unknown price as $0 — the one surface people pay most for breaking the rule that a check that did
 * not complete is never reported as one that passed.
 */

const S = (sig: string) => toFunctionSelector(`function ${sig}`)
const BALANCE_OF = S('balanceOf(address)')
const NOW = 1_700_000_000
const HEAD = 555_555n
const HEAD_TAG = `0x${HEAD.toString(16)}`
const E18 = 10n ** 18n
const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0')
const implementing = (...sigs: string[]) => sigs.map((g) => '8063' + S(g).slice(2) + '14' + '610000' + '57').join('')
const logic = (...parts: string[]) => '0x' + parts.join('') + 'ab'.repeat(3000)

const { sweepMock } = vi.hoisted(() => ({ sweepMock: vi.fn() }))

const chain: {
  codes: Record<string, string>
  /** eth_call answers keyed `${to}:${selector}`; 'THROW' throws. */
  calls: Record<string, string>
  /** balanceOf answers keyed `${token}:${holder}`; 'THROW' throws, 'SLOW' answers 50 tokens after 1s. */
  balances: Record<string, bigint | 'THROW' | 'SLOW'>
  /** [block tag, selector] of every eth_call made. */
  ethCalls: Array<[string, string]>
} = { codes: {}, calls: {}, balances: {}, ethCalls: [] }

vi.mock('../src/lib/chains.js', () => ({
  rhClient: {
    getBlockNumber: async () => HEAD,
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      const p0 = params[0]
      const at = (typeof p0 === 'string' ? p0 : (p0 as { to: string }).to).toLowerCase()
      if (method === 'eth_getCode') return chain.codes[at] ?? '0x'
      if (method === 'eth_getStorageAt') return '0x' + '0'.repeat(64)
      if (method === 'eth_call') {
        const data = (p0 as { data: string }).data
        const sel = data.slice(0, 10)
        chain.ethCalls.push([params[1] as string, sel])
        if (sel === BALANCE_OF) {
          const b = chain.balances[`${at}:0x${data.slice(34, 74)}`]
          if (b === 'THROW') throw new Error('HTTP request failed. Status: 403')
          if (b === 'SLOW') return new Promise((r) => setTimeout(() => r(word(50n * E18)), 1_000))
          return word(b ?? 0n)
        }
        const v = chain.calls[`${at}:${sel}`]
        if (v === undefined || v === 'THROW') throw new Error('execution reverted')
        return v
      }
      throw new Error(`unexpected ${method}`)
    },
  },
}))

const registry: { assets: unknown[]; feeds: unknown[] } = { assets: [], feeds: [] }
vi.mock('../src/lib/sources.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    fetchRhAssets: async () => registry.assets,
    fetchChainlinkFeeds: async () => registry.feeds,
  }
})

vi.mock('../src/sweep/detect.js', () => ({ sweep: sweepMock }))

const surface = await import('../src/lib/surface.js')
const { PAID_ENDPOINTS } = await import('../src/lib/endpoints.js')

const AUDITED = '0xc0ffee0000000000000000000000000000000001' as const

/** A registry entry. `rest` is what the REST registry claims; the chain answers separately. */
function asset(sym: string, token: string, rest = E18) {
  return {
    id: sym,
    tokenSymbol: sym,
    tokenName: sym,
    tokenDecimals: 18,
    currentMultiplier: rest.toString(),
    pendingMultiplier: '',
    status: 'active',
    deployments: [{ contractAddress: token, chainId: 4663 }],
  }
}
function feed(sym: string, proxy: string, usd: bigint) {
  chain.calls[`${proxy}:${S('latestRoundData()')}`] = encodeAbiParameters(
    [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }],
    [9n, usd * 10n ** 8n, BigInt(NOW - 60), BigInt(NOW - 60), 9n],
  )
  chain.calls[`${proxy}:${S('decimals()')}`] = word(8n)
  return { name: `ROBINHOOD ${sym} / USD`, proxyAddress: proxy, decimals: 8, heartbeat: 86_400 }
}
function onChain(token: string, multiplier: bigint | 'THROW') {
  chain.calls[`${token}:${S('uiMultiplier()')}`] = multiplier === 'THROW' ? 'THROW' : word(multiplier)
}

beforeEach(() => {
  chain.codes = { [AUDITED]: logic() }
  chain.calls = {}
  chain.balances = {}
  chain.ethCalls = []
  registry.assets = []
  registry.feeds = []
  sweepMock.mockReset()
})

describe('assay_check_symbol never returns a named integrator', () => {
  const named = {
    id: 'integrator-c0ffee00-CCL',
    defectClass: 'INTEGRATOR_NOT_MULTIPLIER_AWARE',
    severity: 'medium',
    subject: `${AUDITED} (holds CCL)`,
    affectedParty: 'x',
    title: '0xc0ffee00… holds 402.3351 CCL and cannot call uiMultiplier() directly',
    statement: 'x',
    impact: { note: 'x' },
    evidence: [],
    verification: { checked: 1, reproduced: 1 },
  }
  const asset_ = {
    id: 'CCL-share-count',
    defectClass: 'SHARE_COUNT_MISREAD_RISK',
    severity: 'high',
    subject: 'CCL (0xa1)',
    affectedParty: 'x',
    title: 'CCL: reading balanceOf() as shares understates by 2.1034%',
    statement: 'x',
    impact: { note: 'x' },
    evidence: [],
    verification: { checked: 1, reproduced: 1 },
  }

  beforeEach(() => {
    registry.assets = [asset('CCL', '0xa100000000000000000000000000000000000001')]
    // Even if the pass ran anyway, its rows must not come out.
    sweepMock.mockResolvedValue({
      blockNumber: '1',
      observedAt: 'now',
      marketClosed: false,
      cohort: {},
      assetsScanned: 1,
      findings: [asset_, named],
      rejected: [{ finding: named, reason: 'unchecked', detail: '', results: [] }],
      chainNotes: [],
      errors: [],
    })
  })

  it('runs the sweep with the integrator pass OFF', async () => {
    await surface.checkSymbol('ccl')
    expect(sweepMock).toHaveBeenCalledWith({ symbols: ['CCL'], integrators: false })
  })

  it('carries no INTEGRATOR_NOT_MULTIPLIER_AWARE row in checkSymbol or checkSymbolSummary', async () => {
    const r = await surface.checkSymbol('CCL')
    expect(r.findings!.map((f) => f.defectClass)).toEqual(['SHARE_COUNT_MISREAD_RISK'])
    expect(r.published).toBe(1)
    expect(r.rejectedByVerifier).toBe(0)
    expect(JSON.stringify(r)).not.toContain(AUDITED.slice(2, 10))

    const summary = await surface.checkSymbolSummary('CCL')
    expect(JSON.stringify(summary)).not.toContain('INTEGRATOR_NOT_MULTIPLIER_AWARE')
    expect(JSON.stringify(summary)).not.toContain(AUDITED.slice(2, 10))
  })
})

describe('the free contract verdict carries no holdings', () => {
  it('returns verdict, code hash, block and a pointer to the paid audit — and reads no balance', async () => {
    registry.assets = [asset('TOKA', '0xa200000000000000000000000000000000000001')]
    onChain('0xa200000000000000000000000000000000000001', 2n * E18)
    chain.balances[`0xa200000000000000000000000000000000000001:${AUDITED}`] = 100n * E18

    const v = await surface.contractVerdict(AUDITED)
    expect(v.verdict).toBe('NOT_AWARE')
    expect(v.conclusive).toBe(true)
    expect(v.blockNumber).toBe(HEAD.toString())
    expect(v.codeHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(v.fullAudit.x402).toBe(PAID_ENDPOINTS.checkContract.trigger)
    expect(v.fullAudit.paywall).toBe(PAID_ENDPOINTS.checkContract.paywall)
    expect(v.fullAudit.priceUsd).toBe(0.25)
    expect('role' in v).toBe(false)

    expect(Object.keys(v).sort()).toEqual(
      ['address', 'blockNumber', 'codeHash', 'conclusive', 'fullAudit', 'interpretation', 'observedAt', 'verdict'].sort(),
    )
    expect(JSON.stringify(v)).not.toMatch(/holdings|tokenUnits|shareEquivalents|sharesUnaccounted|usdHeld|TOKA/)
    expect(chain.ethCalls.some(([, sel]) => sel === BALANCE_OF)).toBe(false)
  })

  it('names the role of a NOT_APPLICABLE contract', async () => {
    chain.codes[AUDITED] = logic(implementing('slot0()', 'swap(address,bool,int256,uint160,bytes)'))
    const v = await surface.contractVerdict(AUDITED)
    expect(v.verdict).toBe('NOT_APPLICABLE')
    expect(v.role).toBe('AMM_POOL')
    expect(v.interpretation).toMatch(/No claim is made/)
  })
})

describe('the $0.25 audit never reports a failed read or an unknown price as nothing', () => {
  const T = {
    big: '0xa300000000000000000000000000000000000001',
    small: '0xa300000000000000000000000000000000000002',
    one: '0xa300000000000000000000000000000000000003',
    nofeed: '0xa300000000000000000000000000000000000004',
  } as const

  function arrange() {
    // `big` is 1.5x on chain while REST still says 1.0: the chain decides.
    registry.assets = [
      asset('BIG', T.big),
      asset('SMALL', T.small, 1001n * 10n ** 15n),
      asset('ONE', T.one),
      asset('NOFEED', T.nofeed, 2n * E18),
    ]
    registry.feeds = [feed('BIG', '0xfeed000000000000000000000000000000000001', 10n), feed('SMALL', '0xfeed000000000000000000000000000000000002', 20n)]
    onChain(T.big, 15n * 10n ** 17n)
    // 0.1% divergent: the old 0.2% cutoff on the REST value skipped every token like this one.
    onChain(T.small, 1001n * 10n ** 15n)
    onChain(T.one, E18)
    onChain(T.nofeed, 2n * E18)
    chain.balances[`${T.big}:${AUDITED}`] = 100n * E18
    chain.balances[`${T.small}:${AUDITED}`] = 50n * E18
    chain.balances[`${T.one}:${AUDITED}`] = 999n * E18
  }

  it('reads every divergent token on-chain at one pinned block, and cites what it read', async () => {
    arrange()
    const r = await surface.auditContract(AUDITED)
    expect(r.conclusive).toBe(true)
    expect(r.incomplete).toEqual([])
    expect(r.divergentTokensChecked).toBe(3)
    expect(r.holdings.map((h) => h.symbol)).toEqual(['BIG', 'SMALL'])
    expect(r.holdings[0]!.uiMultiplier).toBe((15n * 10n ** 17n).toString())
    expect(r.totalUsdHeld).toBe(2000)
    expect(r.pricedUsdHeld).toBe(2000)

    // Every read at the block the answer cites — balances included, which used to read at `latest`.
    expect(chain.ethCalls.length).toBeGreaterThan(0)
    expect(chain.ethCalls.every(([tag]) => tag === HEAD_TAG)).toBe(true)
    const bal = r.evidence.filter((e) => e.call === 'balanceOf(address)')
    expect(bal).toHaveLength(2)
    expect(bal.every((e) => e.blockNumber === HEAD.toString() && e.calldata?.startsWith(BALANCE_OF))).toBe(true)
    expect(r.evidence.filter((e) => e.call === 'uiMultiplier()')).toHaveLength(2)
    expect(r.evidence.some((e) => e.call === 'getCode()')).toBe(true)
  })

  it('a failed balanceOf makes the answer inconclusive and names the token, instead of dropping it', async () => {
    arrange()
    chain.balances[`${T.small}:${AUDITED}`] = 'THROW'
    const r = await surface.auditContract(AUDITED)
    expect(r.conclusive).toBe(false)
    expect(r.incomplete).toEqual(['SMALL'])
    expect(r.totalUsdHeld).toBeNull()
    expect(r.pricedUsdHeld).toBe(1000)
    expect(r.interpretation).toMatch(/INCOMPLETE/)
  })

  it('a failed feed read is incomplete too, not a $0 holding', async () => {
    arrange()
    chain.calls[`0xfeed000000000000000000000000000000000001:${S('latestRoundData()')}`] = 'THROW'
    const r = await surface.auditContract(AUDITED)
    expect(r.conclusive).toBe(false)
    expect(r.incomplete).toEqual(['BIG'])
    expect(r.holdings.find((h) => h.symbol === 'BIG')!.usdHeld).toBeNull()
    expect(r.totalUsdHeld).toBeNull()
  })

  it('a failed multiplier read is incomplete: whether that token is divergent is unknown', async () => {
    arrange()
    onChain(T.one, 'THROW')
    const r = await surface.auditContract(AUDITED)
    expect(r.conclusive).toBe(false)
    expect(r.incomplete).toEqual(['ONE'])
  })

  it('an unpriced holding makes the total null, never $0', async () => {
    // 444 CCL, which has no feed, came back as totalUsdHeld: 0.
    arrange()
    chain.balances[`${T.nofeed}:${AUDITED}`] = 444n * E18
    const r = await surface.auditContract(AUDITED)
    expect(r.conclusive).toBe(true)
    expect(r.unpricedSymbols).toEqual(['NOFEED'])
    expect(r.holdings.find((h) => h.symbol === 'NOFEED')!.usdHeld).toBeNull()
    expect(r.totalUsdHeld).toBeNull()
    expect(r.pricedUsdHeld).toBe(2000)
  })

  it('answers inconclusive on time when the RPC is too slow for the read budget, naming what it did not read', async () => {
    // ~250 reads measured at 28.5s from a laptop against the agent's 45s and x402's 60s: past that
    // the buyer, who has already paid, got UPSTREAM_UNAVAILABLE instead of an answer.
    arrange()
    chain.balances[`${T.small}:${AUDITED}`] = 'SLOW'
    const started = Date.now()
    const r = await surface.auditContract(AUDITED, { readBudgetMs: 200 })
    expect(Date.now() - started).toBeLessThan(900)
    expect(r.conclusive).toBe(false)
    expect(r.incomplete).toEqual(['SMALL'])
    expect(r.holdings.map((h) => h.symbol)).toEqual(['BIG'])
    expect(r.totalUsdHeld).toBeNull()
    expect(r.pricedUsdHeld).toBe(1000)
    expect(r.interpretation).toMatch(/1 token\(s\) were not read before this audit's 0\.2s read budget ran out \(SMALL\)/)
    expect(r.interpretation).not.toMatch(/read\(s\) failed/)
  })

  it('a contract holding nothing gets a true zero only when every read completed', async () => {
    registry.assets = [asset('BIG', T.big)]
    onChain(T.big, 15n * 10n ** 17n)
    const r = await surface.auditContract(AUDITED)
    expect(r.holdings).toEqual([])
    expect(r.conclusive).toBe(true)
    expect(r.totalUsdHeld).toBe(0)
  })
})

describe('the free true_position verdict', () => {
  it('keeps the refusal and its reason, and leaves the position figures to the paid call', () => {
    const p = {
      symbol: 'CRWD',
      token: '0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931',
      holder: AUDITED,
      rawBalance: '5000000000000000000',
      uiMultiplier: '4000000000000000000',
      multiplier: 4,
      shareEquivalents: 20,
      tokenUnits: 5,
      tokenPriceUsd: 1600,
      underlyingSharePriceUsd: 400,
      positionValueUsd: 8000,
      feed: '0xfeed000000000000000000000000000000000009',
      feedAgeSeconds: 100_000,
      feedHeartbeat: 86_400,
      feedStale: true,
      oraclePaused: false,
      checks: { pauseChecked: true, feedRead: true, priceSane: true, roundComplete: true, multiplierSane: true },
      blockNumber: '1',
      observedAt: 'now',
      refusalReason: 'Chainlink feed is 27.78h old, past its 86400s heartbeat.',
      confidence: 'degraded',
    } as const
    const v = surface.truePositionVerdictPayload(p as never)
    expect(v.confidence).toBe('degraded')
    expect(v.refusalReason).toBe(p.refusalReason)
    expect(v.checks).toEqual(p.checks)
    expect(v.fullAnswer.x402).toBe(PAID_ENDPOINTS.truePosition.trigger)
    expect(v.fullAnswer.priceUsd).toBe(0.01)
    const json = JSON.stringify(v)
    for (const k of ['rawBalance', 'shareEquivalents', 'tokenUnits', 'tokenPriceUsd', 'underlyingSharePriceUsd', 'positionValueUsd'])
      expect(json).not.toContain(`"${k}"`)
    expect(json).not.toContain('8000')
  })
})
