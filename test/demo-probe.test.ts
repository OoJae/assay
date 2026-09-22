import { describe, it, expect, vi } from 'vitest'
import { toFunctionSelector } from 'viem'

const sel = (sig: string) => toFunctionSelector(sig)
const word = (n: bigint) => n.toString(16).padStart(64, '0')

const RETURNS: Record<string, string> = {
  [sel('uiMultiplier()')]: '0x' + word(4_000_000_000_000_000_000n), // 4.0x
  [sel('totalSupply()')]: '0x' + word(1_000_000_000_000_000_000n),
  [sel('decimals()')]: '0x' + word(18n),
  [sel('oraclePaused()')]: '0x' + word(0n),
  [sel('newUIMultiplier()')]: '0x' + word(4_000_000_000_000_000_000n),
  [sel('effectiveAt()')]: '0x' + word(0n),
}
const FEED = '0x00000000000000000000000000000000000000fe'

vi.mock('../src/lib/chains.js', () => ({
  rhClient: {
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ timestamp: 1_800_000_000n }),
    request: async ({ params }: { params: [{ to: string; data: string }, string] }) => {
      const [{ to, data }] = params
      // The FEED contract is unreachable: latestRoundData() and decimals() both fail.
      if (to.toLowerCase() === FEED) throw new Error('fetch failed')
      const r = RETURNS[data.slice(0, 10)]
      if (!r) throw new Error('execution reverted')
      return r
    },
    readContract: async () => { throw new Error('execution reverted') },
  },
}))

vi.mock('../src/lib/sources.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    fetchRhAssets: async () => [
      { tokenSymbol: 'CRWD', deployments: [{ chainId: 4663, contractAddress: '0x0000000000000000000000000000000000000001' }] },
    ],
    fetchChainlinkFeeds: async () => [
      { name: 'ROBINHOOD CRWD / USD', proxyAddress: FEED, heartbeat: 3600, docs: { marketHours: 'US equity 24/5' } },
    ],
    feedForSymbol: () => ({ name: 'ROBINHOOD CRWD / USD', proxyAddress: FEED, heartbeat: 3600, docs: { marketHours: 'US equity 24/5' } }),
    is24x5: () => true,
  }
})

describe('an unreadable FEED', () => {
  it('leaves no trace anywhere', async () => {
    const { sweep } = await import('../src/sweep/detect.js')
    const r = await sweep({ symbols: ['CRWD'], verify: false })
    console.log('SWEEP errors:', JSON.stringify(r.errors))
    console.log('SWEEP stats:', JSON.stringify(r.stats))
    console.log('SWEEP findings:', r.findings.map((f) => f.id))
    console.log('SWEEP rejected:', r.rejected.length)
    expect(r.errors).toEqual([])            // feed read failed; nothing recorded
    expect(r.stats.staleFeeds).toBe(0)      // staleness never evaluated
  })
})
