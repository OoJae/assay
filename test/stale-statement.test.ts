import { describe, it, expect, vi } from 'vitest'
import { encodeAbiParameters, toFunctionSelector } from 'viem'

/**
 * A stale-feed finding may only say the cohort CORROBORATES a closure when it did.
 *
 * The clock decides the weekend first (src/lib/sources.ts), so from Saturday morning the market is
 * closed while most of the cohort is still inside its heartbeat. The statement kept its old
 * sentence, and a byte-verified public finding would have read "1 of the 35 24/5 equity feeds ...
 * are stale, which corroborates a scheduled market closure". Every other sweep fixture runs on a
 * Tuesday, so nothing exercised a weekend block.
 *
 * Runs fully offline against a mocked RPC.
 */

const state = { now: 0, othersStale: false }

// Saturday 2026-09-26 13:00 UTC (09:00 New York): inside the scheduled closure, and the window
// where only the earliest Friday updaters (SPY at 12:22 in the replay) have gone stale.
const SATURDAY = Date.UTC(2026, 8, 26, 13, 0, 0) / 1000
// Tuesday 2026-09-22 15:00 UTC: inside the session.
const TUESDAY = Date.UTC(2026, 8, 22, 15, 0, 0) / 1000

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const PROXY = '0x2222222222222222222222222222222222222222' as const
const HEARTBEAT = 86_400
const STALE_AGE = HEARTBEAT + 3_600
const FRESH_AGE = 60

const sel = {
  latestRoundData: toFunctionSelector('function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'),
  decimals: toFunctionSelector('function decimals() view returns (uint8)'),
  uiMultiplier: toFunctionSelector('function uiMultiplier() view returns (uint256)'),
  newUIMultiplier: toFunctionSelector('function newUIMultiplier() view returns (uint256)'),
  effectiveAt: toFunctionSelector('function effectiveAt() view returns (uint256)'),
  oraclePaused: toFunctionSelector('function oraclePaused() view returns (bool)'),
  totalSupply: toFunctionSelector('function totalSupply() view returns (uint256)'),
}

const word = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')) as `0x${string}`
const round = (age: number) =>
  encodeAbiParameters(
    [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }],
    [5n, 100_00000000n, BigInt(state.now - age), BigInt(state.now - age), 5n],
  )

vi.mock('../src/lib/chains.js', () => {
  const rhClient = {
    getBlockNumber: async () => 1000n,
    getBlock: async () => ({ timestamp: BigInt(state.now) }),
    request: async (args: any) => {
      const { to, data } = args.params[0]
      const s = data.slice(0, 10)
      const addr = to.toLowerCase()
      if (addr === PROXY.toLowerCase()) {
        if (s === sel.latestRoundData) return round(STALE_AGE)
        if (s === sel.decimals) return word(8n)
      }
      if (addr.startsWith('0x3')) {
        if (s === sel.latestRoundData) return round(state.othersStale ? STALE_AGE : FRESH_AGE)
        if (s === sel.decimals) return word(8n)
      }
      if (addr === TOKEN.toLowerCase()) {
        if (s === sel.uiMultiplier || s === sel.newUIMultiplier) return word(10n ** 18n)
        if (s === sel.effectiveAt) return word(0n)
        if (s === sel.oraclePaused) return word(0n)
        if (s === sel.totalSupply) return word(1000n * 10n ** 18n)
        if (s === sel.decimals) return word(18n)
      }
      throw new Error('execution reverted')
    },
  }
  return { rhClient, bscClient: rhClient, avaxClient: rhClient, robinhoodChain: {}, robinhoodTestnet: {}, bsc: {}, avalanche: {} }
})

vi.mock('../src/lib/sources.js', async (orig) => {
  const actual: any = await orig()
  const feed = {
    name: 'ROBINHOOD TEST / USD',
    proxyAddress: PROXY,
    decimals: 8,
    heartbeat: HEARTBEAT,
    docs: { marketHours: 'us_equities_24/5' },
  }
  const cohort = Array.from({ length: 34 }, (_, i) => ({
    ...feed,
    name: `ROBINHOOD OTHER${i} / USD`,
    proxyAddress: ('0x3' + String(i).padStart(39, '0')) as `0x${string}`,
  }))
  return {
    ...actual,
    fetchRhAssets: async () => [
      {
        id: 'x', tokenSymbol: 'TEST', tokenName: 'Test', tokenDecimals: 18,
        currentMultiplier: '1000000000000000000', pendingMultiplier: '1000000000000000000',
        status: 'active', deployments: [{ contractAddress: TOKEN, chainId: 4663 }],
      },
    ],
    fetchChainlinkFeeds: async () => [feed, ...cohort],
    fetchRhUnderlyingPrice: async () => null,
    feedForSymbol: () => feed,
  }
})

async function staleFinding(now: number, othersStale: boolean) {
  state.now = now
  state.othersStale = othersStale
  // bust the 60s cohort cache between runs
  vi.resetModules()
  const { sweep } = await import('../src/sweep/detect.js')
  const r = await sweep({ verify: false, integrators: false })
  const f = r.findings.find((x) => x.defectClass.startsWith('ORACLE_STALE'))
  expect(f).toBeDefined()
  return { r, f: f! }
}

describe('the stale-feed statement claims cohort corroboration only when the cohort corroborates', () => {
  it('Saturday, 1 of 35 stale: closed by the schedule, and it does not say the cohort corroborates it', async () => {
    const { r, f } = await staleFinding(SATURDAY, false)
    expect(r.cohort).toMatchObject({ read: 35, stale: 1, quorum: true, marketClosed: true })
    expect(f.defectClass).toBe('ORACLE_STALE_MARKET_CLOSED')
    expect(f.statement).not.toMatch(/corroborat/i)
    expect(f.statement).toMatch(/closed per the published 24\/5 schedule/)
    expect(f.statement).toMatch(/1 of the 35 24\/5 equity feeds .* are past their heartbeat so far/)
  })

  it('Saturday, 35 of 35 stale: the cohort went stale together, so it may say so', async () => {
    const { f } = await staleFinding(SATURDAY, true)
    expect(f.defectClass).toBe('ORACLE_STALE_MARKET_CLOSED')
    expect(f.statement).toMatch(/35 of the 35 24\/5 equity feeds .* are stale, which corroborates a scheduled market closure/)
  })

  it('Tuesday, 1 of 35 stale: still an incident', async () => {
    const { f } = await staleFinding(TUESDAY, false)
    expect(f.defectClass).toBe('ORACLE_STALE_UNEXPECTED')
    expect(f.statement).not.toMatch(/corroborat/i)
  })
})
