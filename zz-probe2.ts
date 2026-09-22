import { truePosition, type PositionReader } from './src/lib/position.js'
import { findingsPayload, loadSnapshot } from './src/lib/surface.js'
import type { ChainlinkFeed, RhAsset } from './src/lib/sources.js'
import { isTransient } from './src/sweep/oracle.js'

const TOKEN = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931' as const
const HOLDER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const
const FEED = '0x1111111111111111111111111111111111111111' as const
const ASSETS = [{ tokenSymbol: 'TEST', deployments: [{ chainId: 4663, contractAddress: TOKEN }] }] as unknown as RhAsset[]
const FEEDS: ChainlinkFeed[] = [{ name: 'Robinhood TEST / USD', proxyAddress: FEED, decimals: 8, heartbeat: 86400, docs: { marketHours: 'us_equities_24/5' } }]
const NOW = 1_800_000_000n
const base = (over: Partial<PositionReader> = {}): PositionReader => ({
  head: async () => ({ blockNumber: 68_800_493n, timestamp: NOW }),
  balanceOf: async () => 13_026_200_000_000_000_000n,
  uiMultiplier: async () => 4_000_000_000_000_000_000n,
  oraclePaused: async () => false,
  latestRoundData: async () => [5n, 22_244_730_000n, NOW - 60n, NOW - 60n, 5n] as const,
  feedDecimals: async () => 8,
  ...over,
})

console.log('##### (A) uiMultiplier() == 0 #####')
const a = await truePosition('TEST', HOLDER, { reader: base({ uiMultiplier: async () => 0n }), assets: ASSETS, feeds: FEEDS })
console.log('confidence      :', a.confidence)
console.log('refusalReason   :', a.refusalReason)
console.log('multiplier      :', a.multiplier)
console.log('shareEquivalents:', a.shareEquivalents)
console.log('underlyingShare :', a.underlyingSharePriceUsd)
console.log('checks          :', JSON.stringify(a.checks))
console.log('ON THE WIRE     :', JSON.stringify({ confidence: a.confidence, refusalReason: a.refusalReason, shareEquivalents: a.shareEquivalents, underlyingSharePriceUsd: a.underlyingSharePriceUsd, positionValueUsd: a.positionValueUsd }))

console.log('\n##### (A2) uiMultiplier() == 1 wei (dust, not 0) #####')
const a2 = await truePosition('TEST', HOLDER, { reader: base({ uiMultiplier: async () => 1n }), assets: ASSETS, feeds: FEEDS })
console.log(JSON.stringify({ confidence: a2.confidence, refusalReason: a2.refusalReason, multiplier: a2.multiplier, shareEquivalents: a2.shareEquivalents, underlyingSharePriceUsd: a2.underlyingSharePriceUsd }))

console.log('\n##### (B) findingsPayload when data/findings.json is absent/corrupt #####')
const empty = loadSnapshot('/nonexistent/findings.json')
console.log('loadSnapshot(missing) ->', JSON.stringify(empty))
console.log('findingsPayload      ->', JSON.stringify(findingsPayload({}, empty)))

console.log('\n##### (C) isTransient vs the real viem timeout message #####')
const viemTimeout = 'The request took too long to respond.\n\nURL: https://rpc.mainnet.chain.robinhood.com\nRequest body: {"method":"eth_call"}\n\nDetails: The request took too long to respond.\nVersion: viem@2.56.8'
console.log('isTransient(viem TimeoutError) =', isTransient(viemTimeout))
const viemLimit = 'Request exceeds defined limit.\n\nURL: https://rpc.mainnet.chain.robinhood.com\nDetails: Your app has exceeded its compute units per second capacity.\nVersion: viem@2.56.8'
console.log('isTransient(viem LimitExceededRpcError) =', isTransient(viemLimit))

console.log('\n##### (D) does withRetry actually retry a viem timeout? #####')
let calls = 0
const timeoutReader = base({ oraclePaused: async () => { calls++; throw new Error(viemTimeout) } })
const d = await truePosition('TEST', HOLDER, { reader: timeoutReader, assets: ASSETS, feeds: FEEDS })
console.log('oraclePaused attempts observed at reader level (reader is not wrapped) =', calls, '-> confidence', d.confidence)

console.log('\n##### (E) holder address that flips isTransient on a REVERT #####')
const revertWithHolder = 'The contract function "balanceOf" reverted.\n\nContract Call:\n  address:   0x1111111111111111111111111111111111111111\n  function:  balanceOf(address)\n  args:               (0x5025025025025025025025025025025025025025)\n\nDetails: execution reverted\nVersion: viem@2.56.8'
console.log('isTransient(revert w/ 0x502... holder) =', isTransient(revertWithHolder))
