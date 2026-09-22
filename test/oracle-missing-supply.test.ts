import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encodeAbiParameters, toFunctionSelector } from 'viem'

// ---- toggles the harness flips between runs ----
const state = { totalSupplyReverts: false }

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
        if (s === sel.aggDecimals) return word(8n)
      }
      if (to.toLowerCase() === TOKEN.toLowerCase()) {
        if (s === sel.uiMultiplier) return word(4n * 10n ** 18n)
        if (s === sel.newUIMultiplier) return word(4n * 10n ** 18n)
        if (s === sel.effectiveAt) return word(0n)
        if (s === sel.oraclePaused) return word(0n)
        if (s === sel.totalSupply) {
          if (state.totalSupplyReverts) throw new Error('execution reverted')
          return word(1000n * 10n ** 18n)
        }
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
  state.totalSupplyReverts = revert
  // bust the 60s cohort cache between runs
  vi.resetModules()
  const mod = await import('../src/sweep/detect.js')
  return mod.sweep({ verify: false })
}

/**
 * A failed totalSupply() read must never become a fabricated citation.
 *
 * The defect: `totalSupply: ts ? ... : 0n` paired with `rawTotalSupply: ts?.raw ?? '0x'`, so a
 * transient RPC failure published the citation `totalSupply() == 0` carrying the literal bytes
 * `0x`. Nothing ever returned those bytes. Two consequences, both bad:
 *
 *  1. The verifier re-fetches, gets the real supply, mismatches, and drops the ENTIRE finding —
 *     including its perfectly valid uiMultiplier citation. One flaky call discredits a true finding.
 *  2. Until that happened, the project's central claim — every published byte was fetched from
 *     chain state — was false for that citation.
 *
 * The finding is about uiMultiplier(); the supply merely illustrates it. So it now stands without
 * the supply and simply stops quoting a number it does not have.
 */
describe('a failed totalSupply() read never becomes a fabricated citation', () => {
  it('cites totalSupply when it was actually read', async () => {
    const r = await run(false)
    const f = r.findings.find((x) => x.defectClass === 'SHARE_COUNT_MISREAD_RISK')
    expect(f).toBeDefined()
    expect(f!.evidence.some((e) => e.call === 'totalSupply()')).toBe(true)
    expect(f!.impact.note).toMatch(/totalSupply raw/)
  })

  it('still publishes the finding when totalSupply() reverts, citing only what was read', async () => {
    const r = await run(true)
    const f = r.findings.find((x) => x.defectClass === 'SHARE_COUNT_MISREAD_RISK')
    expect(f).toBeDefined()

    // The finding survives — it is about the multiplier, not the supply.
    expect(f!.evidence.some((e) => e.call === 'uiMultiplier()')).toBe(true)
    // ...and no totalSupply citation is manufactured.
    expect(f!.evidence.some((e) => e.call === 'totalSupply()')).toBe(false)
    expect(f!.impact.note).toMatch(/could not be read at this block/i)
  })

  it('NEVER publishes 0x as a raw return value', async () => {
    // The literal guarantee, asserted literally: every citation on every finding carries bytes
    // that a call actually returned.
    for (const revert of [false, true]) {
      const r = await run(revert)
      for (const f of r.findings) {
        for (const e of f.evidence) {
          expect(e.rawReturn).not.toBe('0x')
          expect(e.rawReturn.length).toBeGreaterThan(2)
        }
      }
    }
  })
})
