import type { PublicClient } from 'viem'

/**
 * erc8056-guard — read Robinhood Chain Stock Tokens correctly, or refuse.
 *
 * Under ERC-8056 a corporate action moves `uiMultiplier()`, not balances. So `balanceOf()` returns
 * TOKENS and the share-equivalent count is `balance * uiMultiplier() / 1e18`. Get that wrong and a
 * CRWD holder with 13 tokens is reported as holding 13 shares when they hold 52.
 *
 * This package is free and preventive. It is the other half of ASSAY, which detects the mistake
 * after the fact and publishes it: measured on chain 4663, roughly 80% of the addresses holding
 * these tokens are contracts, and the substantial ones sampled contained no `uiMultiplier()`
 * selector at all — they could not make the correction even in principle.
 *
 * THE REFUSAL IS THE POINT. When the inputs do not support a number this returns `safe: false`
 * with a reason instead of a plausible-looking wrong figure. A naive integration returns the wrong
 * figure by default, silently, and that is the failure mode worth preventing.
 */

export const CHAIN_ID = 4663
export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'

/** 1e18 fixed point, regardless of the token's own decimals(). */
export const ONE = 10n ** 18n

/** Every Robinhood equity feed publishes this heartbeat. */
export const DEFAULT_HEARTBEAT_SECONDS = 86_400

export const stockTokenAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'uiMultiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'oraclePaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const

export const aggregatorV3Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const

export interface GuardedReading {
  /** balance * uiMultiplier / 1e18, in wei. Null when unsafe. */
  shareEquivalents: bigint | null
  /** The raw ERC-20 balance. NOT a share count. */
  rawBalance: bigint | null
  multiplier: bigint | null
  /** False means the reading must not be acted on. */
  safe: boolean
  /** Why it is unsafe. Empty when safe. */
  reason: string
  /** Which checks COMPLETED. False means unknown, not fine. */
  checks: { balanceRead: boolean; multiplierRead: boolean; multiplierSane: boolean; pauseChecked: boolean; notPaused: boolean }
}

/**
 * Pure arithmetic, exact in bigint. Exported so it can be used without any RPC at all — this is
 * the one line most integrations get wrong, and it should be trivially copyable.
 */
export function toShareEquivalents(rawBalance: bigint, uiMultiplier: bigint): bigint {
  return (rawBalance * uiMultiplier) / ONE
}

/** The inverse: given a share count, the token balance that represents it. */
export function toTokenUnits(shareEquivalents: bigint, uiMultiplier: bigint): bigint {
  if (uiMultiplier === 0n) throw new Error('uiMultiplier is zero')
  return (shareEquivalents * ONE) / uiMultiplier
}

const fail = (reason: string, checks: GuardedReading['checks']): GuardedReading => ({
  shareEquivalents: null,
  rawBalance: null,
  multiplier: null,
  safe: false,
  reason,
  checks,
})

/**
 * Share-equivalents for a holder, with every safety check the docs require.
 *
 * Mirrors the on-chain ERC8056Guard and ASSAY's paid `truePosition()` primitive, in the same order.
 * A check that did not COMPLETE is never reported as one that passed.
 */
export async function shareEquivalents(
  client: PublicClient,
  token: `0x${string}`,
  holder: `0x${string}`,
): Promise<GuardedReading> {
  const checks = { balanceRead: false, multiplierRead: false, multiplierSane: false, pauseChecked: false, notPaused: false }

  let rawBalance: bigint
  try {
    rawBalance = (await client.readContract({ address: token, abi: stockTokenAbi, functionName: 'balanceOf', args: [holder] })) as bigint
    checks.balanceRead = true
  } catch {
    return fail('balanceOf() unreadable', checks)
  }

  let multiplier: bigint
  try {
    multiplier = (await client.readContract({ address: token, abi: stockTokenAbi, functionName: 'uiMultiplier' })) as bigint
    checks.multiplierRead = true
  } catch {
    return fail('uiMultiplier() unreadable', checks)
  }
  if (multiplier <= 0n) return fail('uiMultiplier() is zero', checks)
  checks.multiplierSane = true

  // oraclePaused() is a SAFETY check: failing to read it is not the same as reading false.
  try {
    const paused = (await client.readContract({ address: token, abi: stockTokenAbi, functionName: 'oraclePaused' })) as boolean
    checks.pauseChecked = true
    if (paused) return fail('oraclePaused() is true', checks)
    checks.notPaused = true
  } catch {
    return fail('oraclePaused() unreadable — corporate-action check did not complete', checks)
  }

  return { shareEquivalents: toShareEquivalents(rawBalance, multiplier), rawBalance, multiplier, safe: true, reason: '', checks }
}

export interface FeedReading {
  usable: boolean
  reason: string
  /** Multiplier-adjusted TOKEN price. Already includes the corporate action — do NOT re-apply it. */
  price: number | null
  ageSeconds: number | null
}

/**
 * Is this Chainlink feed safe to price from?
 *
 * The feed returns a TOKEN price that ALREADY includes the multiplier. Applying the multiplier to
 * it again is the single most common ERC-8056 mistake and Robinhood's own docs warn about it, so
 * this returns the price unmodified and says so.
 */
export async function readFeed(
  client: PublicClient,
  feed: `0x${string}`,
  nowSeconds: number,
  heartbeat = DEFAULT_HEARTBEAT_SECONDS,
): Promise<FeedReading> {
  try {
    const [roundId, answer, , updatedAt, answeredInRound] = (await client.readContract({
      address: feed,
      abi: aggregatorV3Abi,
      functionName: 'latestRoundData',
    })) as readonly [bigint, bigint, bigint, bigint, bigint]

    if (answer <= 0n) return { usable: false, reason: 'non-positive answer is not a price', price: null, ageSeconds: null }
    if (answeredInRound < roundId) return { usable: false, reason: 'incomplete round — answer carried from an earlier one', price: null, ageSeconds: null }

    // A wrong exponent is a 10^n error, so an unreadable decimals() refuses rather than guessing 8.
    const decimals = (await client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: 'decimals' })) as number

    const ageSeconds = nowSeconds - Number(updatedAt)
    if (ageSeconds > heartbeat) {
      return { usable: false, reason: `feed is ${(ageSeconds / 3600).toFixed(1)}h old, past its ${heartbeat}s heartbeat`, price: null, ageSeconds }
    }
    return { usable: true, reason: '', price: Number(answer) / 10 ** Number(decimals), ageSeconds }
  } catch (err) {
    return { usable: false, reason: `feed unreadable: ${(err as Error).message.slice(0, 80)}`, price: null, ageSeconds: null }
  }
}

/**
 * Does this contract's own bytecode reference uiMultiplier()?
 *
 * FALSE IS NOT AN ACCUSATION. It means the call cannot be made from this bytecode — a contract
 * that only custodies or routes the token never needs the multiplier. Note this does NOT resolve
 * proxies: a proxy stub contains no application selectors, so it will report false for a perfectly
 * correct implementation. ASSAY's auditor resolves EIP-1967, beacon and EIP-1167 proxies; if you
 * need that, use it rather than this.
 */
export const UI_MULTIPLIER_SELECTOR = '0xa60bf13d'

export async function referencesMultiplier(
  client: PublicClient,
  address: `0x${string}`,
): Promise<{ found: boolean; codeSize: number; isLikelyProxy: boolean }> {
  const code = await client.getCode({ address })
  const hex = code ?? '0x'
  const codeSize = Math.max(0, (hex.length - 2) / 2)
  return {
    found: hex.toLowerCase().includes(UI_MULTIPLIER_SELECTOR.slice(2)),
    codeSize,
    // Anything this small is a stub, and the answer above is not meaningful for it.
    isLikelyProxy: codeSize > 0 && codeSize < 2048,
  }
}
