import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encodeAbiParameters, toFunctionSelector } from 'viem'

// ---- toggles the harness flips between runs ----
const state = { feedDecimalsReverts: false }

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const PROXY = '0x2222222222222222222222222222222222222222' as const

const NOW = 1_700_000_000 // fixed block timestamp
const AGE = 200_000       // 55.6h
const HEARTBEAT = 86_400

const sel = {
  latestRoundData: toFunctionSelector('function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'),
  aggDecimals: toFunctionSelector('function decimals() view returns (uint8)'),
  uiMultiplier: toFunctionSelector('function uiMultiplier() view returns (uint256)'),
  newUIMultiplier: toFunctionSelector('function newUIMultiplier() view returns (uint256)'),
  effectiveAt: toFunctionSelector('function effectiveAt() view returns (uint256)'),
  oraclePaused: toFunctionSelector('function oraclePaused() view returns (bool)'),
  totalSupply: toFunctionSelector('function totalSupply() view returns (uint256)'),
}

const word = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')) as `0x${string}`

vi.mock('../src/lib/chains.js', () => {
  const rhClient = {
    getBlockNumber: async () => 1000n,
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    request: async (args: any) => {
      const { to, data } = args.params[0]
      const s = data.slice(0, 10)
      if (to.toLowerCase() === PROXY.toLowerCase()) {
        if (s === sel.latestRoundData) {
          return encodeAbiParameters(
            [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }],
            [5n, 100_00000000n, BigInt(NOW - AGE), BigInt(NOW - AGE), 5n],
          )
        }
        if (s === sel.aggDecimals) {
          if (state.feedDecimalsReverts) throw new Error('execution reverted')
          return word(8n)
        }
      }
      if (to.toLowerCase() === TOKEN.toLowerCase()) {
        if (s === sel.uiMultiplier) return word(4n * 10n ** 18n)
        if (s === sel.newUIMultiplier) return word(4n * 10n ** 18n)
        if (s === sel.effectiveAt) return word(0n)
        if (s === sel.oraclePaused) return word(0n)
        if (s === sel.totalSupply) return word(1000n * 10n ** 18n)
        if (s === sel.aggDecimals) return word(18n)
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
  // 35-strong cohort; only our TEST feed is the one the asset maps to.
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
        currentMultiplier: '4000000000000000000', pendingMultiplier: '4000000000000000000',
        status: 'active', deployments: [{ contractAddress: TOKEN, chainId: 4663 }],
      },
    ],
    fetchChainlinkFeeds: async () => [feed, ...cohort],
    fetchRhUnderlyingPrice: async () => null,
    feedForSymbol: () => feed,
  }
})

const { sweep } = await import('../src/sweep/detect.js')

async function run(revert: boolean) {
  state.feedDecimalsReverts = revert
  // bust the 60s cohort cache between runs
  vi.resetModules()
  const mod = await import('../src/sweep/detect.js')
  return mod.sweep({ verify: false })
}

/**
 * A failed decimals() read must NOT suppress a staleness finding.
 *
 * Adapted from the reproduction an adversarial reviewer built to demonstrate the regression, and
 * inverted to assert the fixed behaviour. The defect: an earlier fix made readFeed() return null
 * when decimals() failed — correct instinct (a silent default of 8 is a 10^n price error) but the
 * wrong blast radius, because detect.ts reads a null feed reading as "no feed here". So an
 * unrelated failed call silently deleted a TRUE staleness finding.
 *
 * Staleness is measured against updatedAt, which arrived. Only the exponent that turns `answer`
 * into dollars was missing. Dropping a true finding because a different call failed is exactly
 * what the retention bug taught this project not to repeat.
 *
 * Runs fully offline against a mocked RPC.
 */
describe('a failed decimals() read does not delete a true staleness finding', () => {
  it('reports the stale feed when decimals() succeeds', async () => {
    const r = await run(false)
    expect(r.stats.staleFeeds).toBe(1)
    expect(r.errors).toHaveLength(0)
  })

  it('STILL reports the stale feed when decimals() reverts', async () => {
    const r = await run(true)
    expect(r.stats.staleFeeds).toBe(1)
    expect(r.errors).toHaveLength(0)
    expect(r.assetsScanned).toBe(1)

    const stale = r.findings.find((f) => f.defectClass.startsWith('ORACLE_STALE'))
    expect(stale).toBeDefined()
    // It must not quote a dollar figure it could not compute...
    expect(stale!.impact.note).toMatch(/decimals\(\) could not be read/i)
    expect(stale!.impact.note).not.toMatch(/Price \d/)
    // ...but the staleness itself is still cited from latestRoundData's real bytes.
    expect(stale!.evidence.some((e) => e.call === 'latestRoundData()')).toBe(true)
  })

  it('does NOT emit a cross-surface finding without a price — that claim needs two numbers', async () => {
    const r = await run(true)
    expect(r.findings.some((f) => f.defectClass === 'CROSS_SURFACE_PRICE_MIX')).toBe(false)
  })
})
