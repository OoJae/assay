import { describe, it, expect } from 'vitest'
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, formatUnits, numberToHex } from 'viem'
import {
  aggregatorV3Abi,
  FUTURE_TOLERANCE_SECONDS,
  readFeed,
  shareEquivalents,
  stockTokenAbi,
  toShareEquivalents,
  toTokenUnits,
} from '../src/index.js'

/**
 * erc8056-guard against a fake chain, through viem's real encoding and decoding. No network.
 *
 * The fake chain's head moves on EVERY request, the way a ~100ms-block chain does between three
 * sequential calls, and its multiplier changes at a known block. A read made at "latest" therefore
 * lands on a different block from the one before it; only a read pinned to a block number is
 * stable. That is the failure the pinning fixes, so the harness makes it the default.
 */

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const FEED = '0x2222222222222222222222222222222222222222' as const
const HOLDER = '0x3333333333333333333333333333333333333333' as const

const START = 100n
const SPLIT_AT = 101n // uiMultiplier() goes 1.0 -> 4.0 from this block
const T0 = 1_790_000_000 // timestamp of block START; blocks are 1s apart here

interface Fake {
  balance?: bigint
  paused?: boolean
  pausedReverts?: boolean
  multiplierAt?: (block: bigint) => bigint
  headReverts?: boolean
  round?: { roundId: bigint; answer: bigint; updatedAt: bigint; answeredInRound: bigint }
  feedDecimals?: number
}

function fakeChain(f: Fake = {}) {
  let head = START
  const log: { method: string; fn?: string; block?: string }[] = []
  const multiplierAt = f.multiplierAt ?? ((b: bigint) => (b >= SPLIT_AT ? 4n * 10n ** 18n : 10n ** 18n))

  const request = async ({ method, params }: { method: string; params?: any }) => {
    const current = head
    head += 1n
    if (method === 'eth_blockNumber') {
      log.push({ method })
      if (f.headReverts) throw new Error('rpc down')
      return numberToHex(current)
    }
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0] as string
      const n = tag === 'latest' ? current : BigInt(tag)
      log.push({ method, block: numberToHex(n) })
      return { number: numberToHex(n), timestamp: numberToHex(BigInt(T0) + (n - START)), hash: '0x' + '00'.repeat(32) }
    }
    if (method === 'eth_call') {
      const [{ to, data }, tag] = params as [{ to: string; data: `0x${string}` }, string]
      const at = tag === 'latest' ? current : BigInt(tag)
      if (to.toLowerCase() === TOKEN.toLowerCase()) {
        const { functionName } = decodeFunctionData({ abi: stockTokenAbi, data })
        log.push({ method, fn: functionName, block: tag })
        if (functionName === 'balanceOf') return encodeFunctionResult({ abi: stockTokenAbi, functionName, result: f.balance ?? 12170934382292353850n })
        if (functionName === 'uiMultiplier') return encodeFunctionResult({ abi: stockTokenAbi, functionName, result: multiplierAt(at) })
        if (functionName === 'oraclePaused') {
          if (f.pausedReverts) throw new Error('execution reverted')
          return encodeFunctionResult({ abi: stockTokenAbi, functionName, result: f.paused ?? false })
        }
      }
      if (to.toLowerCase() === FEED.toLowerCase()) {
        const { functionName } = decodeFunctionData({ abi: aggregatorV3Abi, data })
        log.push({ method, fn: functionName, block: tag })
        if (functionName === 'decimals') return encodeFunctionResult({ abi: aggregatorV3Abi, functionName, result: f.feedDecimals ?? 8 })
        const r = f.round ?? { roundId: 7n, answer: 181_42000000n, updatedAt: BigInt(T0 - 600), answeredInRound: 7n }
        return encodeFunctionResult({
          abi: aggregatorV3Abi,
          functionName,
          result: [r.roundId, r.answer, r.updatedAt, r.updatedAt, r.answeredInRound],
        })
      }
      throw new Error('execution reverted')
    }
    throw new Error(`unexpected ${method}`)
  }

  // cacheTime 0: viem otherwise caches eth_blockNumber per client, which would hide what we count.
  // retryCount 0: a revert here is the answer under test, not a transient fault to retry.
  const client = createPublicClient({ transport: custom({ request }, { retryCount: 0 }), cacheTime: 0 })
  return { client, log }
}

describe('toShareEquivalents — the arithmetic, exact in bigint', () => {
  it('is in the token base units, not a count of shares: format it with formatUnits(…, decimals)', () => {
    // CRWD (18 decimals), holder 0x8366…0951 at block 70063767: 12.1709 tokens at a 4.0 multiplier.
    const shares = toShareEquivalents(12170934382292353850n, 4n * 10n ** 18n)
    expect(shares).toBe(48683737529169415400n)
    expect(formatUnits(shares, 18)).toBe('48.6837375291694154')
    expect(toTokenUnits(shares, 4n * 10n ** 18n)).toBe(12170934382292353850n)
  })
})

describe('shareEquivalents — every read at ONE block', () => {
  it('pins balanceOf, uiMultiplier and oraclePaused to the block it fetched once, and reports it', async () => {
    const { client, log } = fakeChain()
    const r = await shareEquivalents(client, TOKEN, HOLDER)

    expect(r.safe).toBe(true)
    expect(r.blockNumber).toBe(START)
    const calls = log.filter((c) => c.method === 'eth_call')
    expect(calls.map((c) => c.fn)).toEqual(['balanceOf', 'uiMultiplier', 'oraclePaused'])
    expect(calls.every((c) => c.block === numberToHex(START))).toBe(true)
    expect(log.filter((c) => c.method === 'eth_blockNumber')).toHaveLength(1)
    // Unpinned, uiMultiplier() ran one block later and read 4.0 against a pre-split balance.
    expect(r.multiplier).toBe(10n ** 18n)
    expect(r.shareEquivalents).toBe(12170934382292353850n)
  })

  it('uses a caller-supplied block without asking for the head', async () => {
    const { client, log } = fakeChain()
    const r = await shareEquivalents(client, TOKEN, HOLDER, { blockNumber: 500n })

    expect(r.blockNumber).toBe(500n)
    expect(r.multiplier).toBe(4n * 10n ** 18n)
    expect(log.some((c) => c.method === 'eth_blockNumber')).toBe(false)
    expect(log.every((c) => c.block === numberToHex(500n))).toBe(true)
  })

  it('refuses, and does not throw, when the block number cannot be read', async () => {
    const { client, log } = fakeChain({ headReverts: true })
    const r = await shareEquivalents(client, TOKEN, HOLDER)

    expect(r).toMatchObject({ safe: false, reason: 'block number unreadable', shareEquivalents: null, blockNumber: null })
    expect(log.some((c) => c.method === 'eth_call')).toBe(false)
  })

  it('an unreadable oraclePaused() is a refusal, never a pass', async () => {
    const { client } = fakeChain({ pausedReverts: true })
    const r = await shareEquivalents(client, TOKEN, HOLDER)

    expect(r.safe).toBe(false)
    expect(r.reason).toMatch(/oraclePaused\(\) unreadable/)
    expect(r.checks).toEqual({ balanceRead: true, multiplierRead: true, multiplierSane: true, pauseChecked: false, notPaused: false })
  })

  it('refuses a paused token and a zero multiplier', async () => {
    const paused = await shareEquivalents(fakeChain({ paused: true }).client, TOKEN, HOLDER)
    expect(paused).toMatchObject({ safe: false, reason: 'oraclePaused() is true', shareEquivalents: null })

    const zero = await shareEquivalents(fakeChain({ multiplierAt: () => 0n }).client, TOKEN, HOLDER)
    expect(zero).toMatchObject({ safe: false, reason: 'uiMultiplier() is zero' })
    expect(zero.checks.multiplierSane).toBe(false)
  })
})

describe('readFeed — freshness against a clock that can be wrong', () => {
  it('refuses a round from the future instead of calling it fresh', async () => {
    // The regression: age = now - updatedAt went negative and passed `age > heartbeat`.
    const round = { roundId: 7n, answer: 181_42000000n, updatedAt: BigInt(T0 + 3600), answeredInRound: 7n }
    const r = await readFeed(fakeChain({ round }).client, FEED, T0)

    expect(r.usable).toBe(false)
    expect(r.price).toBeNull()
    expect(r.reason).toMatch(/3600s in the future/)
  })

  it('tolerates a local clock a few seconds behind the chain, and never reports a negative age', async () => {
    const round = { roundId: 7n, answer: 181_42000000n, updatedAt: BigInt(T0 + FUTURE_TOLERANCE_SECONDS - 1), answeredInRound: 7n }
    const r = await readFeed(fakeChain({ round }).client, FEED, T0)

    expect(r).toMatchObject({ usable: true, price: 181.42, ageSeconds: 0 })
  })

  it('without a clock, measures age at the timestamp of the block it pins both reads to', async () => {
    const { client, log } = fakeChain()
    const r = await readFeed(client, FEED)

    expect(r).toMatchObject({ usable: true, price: 181.42, ageSeconds: 600, blockNumber: START })
    const calls = log.filter((c) => c.method === 'eth_call')
    expect(calls.map((c) => c.fn)).toEqual(['latestRoundData', 'decimals'])
    expect(calls.every((c) => c.block === numberToHex(START))).toBe(true)
  })

  it('refuses updatedAt == 0 whatever heartbeat the caller passes', async () => {
    const round = { roundId: 7n, answer: 181_42000000n, updatedAt: 0n, answeredInRound: 7n }
    const r = await readFeed(fakeChain({ round }).client, FEED, T0, Number.MAX_SAFE_INTEGER)

    expect(r.usable).toBe(false)
    expect(r.reason).toMatch(/updatedAt is zero/)
  })

  it('still refuses a stale round, and says how stale', async () => {
    const round = { roundId: 7n, answer: 181_42000000n, updatedAt: BigInt(T0 - 200_000), answeredInRound: 7n }
    const r = await readFeed(fakeChain({ round }).client, FEED, T0)

    expect(r).toMatchObject({ usable: false, ageSeconds: 200_000, price: null })
    expect(r.reason).toMatch(/55\.6h old/)
  })
})
