import { encodeFunctionData, decodeFunctionResult } from 'viem'
import { rhClient } from '../lib/chains.js'
import { aggregatorV3Abi, stockTokenAbi } from '../lib/abis.js'
import type { Evidence } from './types.js'

const EXPLORER = 'https://robinhoodchain.blockscout.com'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A transient failure is worth retrying; a revert or a pruned block is not. */
export function isTransient(message: string): boolean {
  const m = message.toLowerCase()
  if (m.includes('execution reverted')) return false
  if (m.includes('historical state')) return false
  return (
    m.includes('timeout') ||
    m.includes('econnreset') ||
    m.includes('socket') ||
    m.includes('fetch failed') ||
    m.includes('rate limit') ||
    m.includes('429') ||
    m.includes('502') ||
    m.includes('503') ||
    m.includes('504')
  )
}

/**
 * Perform an eth_call and keep the RAW hex alongside the decoded value.
 * Findings cite rawReturn so any third party can reproduce the exact bytes.
 *
 * Retries transient RPC failures. Without this, a single dropped socket silently
 * discarded a true finding — see the retention bug in the plan.
 */
export async function rawCall<TAbi extends readonly unknown[]>(
  abi: TAbi,
  address: `0x${string}`,
  functionName: string,
  blockNumber: bigint,
  attempts = 3,
): Promise<{ raw: string; decoded: unknown } | null> {
  let lastErr = ''
  for (let i = 0; i < attempts; i++) {
    try {
      const data = encodeFunctionData({ abi: abi as never, functionName } as never)
      const raw = (await rhClient.request({
        method: 'eth_call',
        params: [{ to: address, data }, `0x${blockNumber.toString(16)}`],
      } as never)) as string
      if (!raw || raw === '0x') return null
      const decoded = decodeFunctionResult({
        abi: abi as never,
        functionName,
        data: raw as `0x${string}`,
      } as never)
      return { raw, decoded }
    } catch (err) {
      lastErr = (err as Error).message ?? String(err)
      if (!isTransient(lastErr)) return null
      await sleep(150 * 2 ** i)
    }
  }
  return null
}

export function evidence(
  claim: string,
  contract: `0x${string}`,
  call: string,
  rawReturn: string,
  blockNumber: bigint,
  observedAt: string,
): Evidence {
  return {
    claim,
    chainId: 4663,
    contract,
    call,
    rawReturn,
    blockNumber: blockNumber.toString(),
    explorerUrl: `${EXPLORER}/address/${contract}`,
    observedAt,
  }
}

export interface OracleReading {
  roundId: bigint
  answeredInRound: bigint
  answer: bigint
  updatedAt: bigint
  decimals: number
  price: number
  ageSeconds: number
  heartbeat: number
  stale: boolean
  /** False when the answer is non-positive or the round never completed. */
  usable: boolean
  raw: string
}

export async function readFeed(
  proxy: `0x${string}`,
  heartbeat: number,
  nowSeconds: number,
  blockNumber: bigint,
): Promise<OracleReading | null> {
  const r = await rawCall(aggregatorV3Abi, proxy, 'latestRoundData', blockNumber)
  if (!r) return null
  const tuple = r.decoded as readonly [bigint, bigint, bigint, bigint, bigint]
  const roundId = tuple[0]
  const answer = tuple[1]
  const updatedAt = tuple[3]
  const answeredInRound = tuple[4]
  const d = await rawCall(aggregatorV3Abi, proxy, 'decimals', blockNumber)
  // A missing decimals() read is NOT 8 by assumption — a wrong exponent is a 10^n price error.
  // Returning null makes the caller treat this as an unread feed instead of a confident number.
  if (!d) return null
  const decimals = Number(d.decoded as number)
  const ageSeconds = nowSeconds - Number(updatedAt)
  return {
    roundId,
    answeredInRound,
    answer,
    updatedAt,
    decimals,
    price: Number(answer) / 10 ** decimals,
    ageSeconds,
    heartbeat,
    stale: ageSeconds > heartbeat,
    /** A non-positive answer is not a price, and an incomplete round carries an older one. */
    usable: answer > 0n && answeredInRound >= roundId,
    raw: r.raw,
  }
}

export interface TokenReading {
  multiplier: bigint
  multiplierFloat: number
  decimals: number
  totalSupply: bigint
  oraclePaused: boolean | null
  pendingMultiplier: bigint | null
  effectiveAt: bigint | null
  rawMultiplier: string
  rawTotalSupply: string
  /**
   * The RAW bytes each of these calls actually returned.
   *
   * These exist because findings used to cite the wrong call's bytes. PENDING_CORPORATE_ACTION
   * claimed `newUIMultiplier() == X` and attached rawMultiplier — the bytes of uiMultiplier().
   * Those two are byte-identical only while NO corporate action is pending, so the citation
   * reproduced right up until the moment the finding became true, and then the verifier
   * mismatched and discarded the single highest-value early warning this tool can emit as
   * fabrication. ORACLE_PAUSED was worse: it SYNTHESISED its rawReturn in source as a hand-built
   * word of 31 zeros and a 1, which made "every raw byte was published after being fetched from
   * chain state" false on its face.
   */
  rawPendingMultiplier: string | null
  rawEffectiveAt: string | null
  rawOraclePaused: string | null
}

export async function readStockToken(
  token: `0x${string}`,
  blockNumber: bigint,
): Promise<TokenReading | null> {
  const m = await rawCall(stockTokenAbi, token, 'uiMultiplier', blockNumber)
  if (!m) return null
  const ts = await rawCall(stockTokenAbi, token, 'totalSupply', blockNumber)
  const dec = await rawCall(stockTokenAbi, token, 'decimals', blockNumber)
  const paused = await rawCall(stockTokenAbi, token, 'oraclePaused', blockNumber)
  const pend = await rawCall(stockTokenAbi, token, 'newUIMultiplier', blockNumber)
  const eff = await rawCall(stockTokenAbi, token, 'effectiveAt', blockNumber)
  const multiplier = m.decoded as bigint
  return {
    multiplier,
    multiplierFloat: Number(multiplier) / 1e18,
    decimals: dec ? Number(dec.decoded as number) : 18,
    totalSupply: ts ? (ts.decoded as bigint) : 0n,
    oraclePaused: paused ? (paused.decoded as boolean) : null,
    pendingMultiplier: pend ? (pend.decoded as bigint) : null,
    effectiveAt: eff ? (eff.decoded as bigint) : null,
    rawMultiplier: m.raw,
    rawTotalSupply: ts?.raw ?? '0x',
    rawPendingMultiplier: pend?.raw ?? null,
    rawEffectiveAt: eff?.raw ?? null,
    rawOraclePaused: paused?.raw ?? null,
  }
}
