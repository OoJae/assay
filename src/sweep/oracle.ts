import { encodeFunctionData, decodeFunctionResult } from 'viem'
import { rhClient } from '../lib/chains.js'
import { aggregatorV3Abi, stockTokenAbi } from '../lib/abis.js'
import { pastHeartbeat } from '../lib/sources.js'
import type { Evidence } from './types.js'

const EXPLORER = 'https://robinhoodchain.blockscout.com'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The error and every `cause` beneath it, outermost first. viem nests the HTTP fault 2-3 deep. */
function causeChain(err: unknown): unknown[] {
  const out: unknown[] = []
  for (let e = err; e != null && out.length < 10 && !out.includes(e); e = (e as { cause?: unknown }).cause) {
    out.push(e)
  }
  return out
}

const errName = (e: unknown) => (typeof e === 'object' && e !== null ? String((e as Error).name ?? '') : '')

/** HTTP statuses a retry can outlive: Cloudflare's challenge page (403), timeouts, rate limits, 5xx. */
const transientStatus = (s: unknown) =>
  typeof s === 'number' && (s === 403 || s === 408 || s === 429 || s >= 500)

/**
 * JSON-RPC codes that mean "not now" rather than "no": LimitExceeded (-32005), Internal (-32603),
 * QuickNode's rate limit (-32007), and the bare 429 some providers put in a 200 response body.
 */
const TRANSIENT_RPC_CODES = new Set([-32005, -32603, -32007, 429])

/**
 * Phrases that mean the same, for plain strings and for errors that did not come from viem. The
 * block phrases are a fallback RPC a few blocks behind the one that reported the head: official
 * "unsupported block number", dRPC "Unknown block", Pocket "header not found", all measured.
 */
const TRANSIENT_TEXT = [
  'timeout',
  'timed out',
  'took too long',
  'econnreset',
  'econnrefused',
  'enotfound',
  'socket',
  'fetch failed',
  'network',
  'rate limit',
  'too many requests',
  'limitexceeded',
  'internalrpcerror',
  'unsupported block number',
  'unknown block',
  'header not found',
]

/**
 * A transient failure is worth retrying; a revert or a pruned block is not.
 *
 * TAKES THE ERROR, NOT ITS MESSAGE. This matched substrings of `err.message` on the stated premise
 * that viem's error class names appear in the message it throws. They do not: a Cloudflare 403 is
 * an HttpRequestError whose message reads "HTTP request failed. Status: 403", a hung request is a
 * TimeoutError reading "The request took too long to respond.", and readContract wraps both two
 * levels down inside ContractFunctionExecutionError. So the retry never fired for the two faults
 * this RPC actually has, the paid call failed ~1.5s into a 12s budget, and the sweep dropped the
 * read. Walking the cause chain and reading `status`, `code` and the class name is what works.
 *
 * A string is still accepted for old callers, and is judged on its text alone.
 */
export function isTransient(err: unknown): boolean {
  const links = causeChain(err)
  const text = links
    .map((e) => (typeof e === 'string' ? e : `${errName(e)}: ${(e as Error)?.message ?? String(e)}`))
    .join('\n')
    .toLowerCase()
  // A revert is the contract's answer and a pruned block is not coming back. Neither is retried,
  // whatever else the chain says.
  if (text.includes('execution reverted')) return false
  if (text.includes('contractfunctionrevertederror')) return false
  if (text.includes('historical state')) return false

  for (const e of links) {
    const name = errName(e)
    // By name rather than instanceof, so an error from a second copy of viem still classifies.
    if (name === 'TimeoutError') return true
    if (name === 'HttpRequestError' && transientStatus((e as { status?: unknown }).status)) return true
    const code = (e as { code?: unknown } | null)?.code
    if (typeof code === 'number' && TRANSIENT_RPC_CODES.has(code)) return true
  }
  return (
    TRANSIENT_TEXT.some((t) => text.includes(t)) ||
    // "Status: 503" as viem prints it. A bare '503' also matched digits inside an address or a
    // calldata word in the message, which retried a revert until the deadline.
    /\bstatus:?\s*(403|408|429|5\d\d)\b/.test(text)
  )
}

/**
 * One line, safe to log and to hand a buyer.
 *
 * A Cloudflare 403 from this RPC carries ~5KB of challenge-page HTML in its details, and that
 * went verbatim into agent.log, into MCP responses and into refusalReason. Only the host of the
 * URL is kept, because a keyed provider's URL carries its key in the path.
 */
export function describeRpcError(err: unknown): string {
  for (const e of causeChain(err)) {
    const name = errName(e)
    if (name === 'HttpRequestError') {
      const { status, details, url } = e as { status?: number; details?: string; url?: string }
      let host = 'RPC'
      try {
        if (url) host = new URL(url).host
      } catch {
        /* keep the generic label */
      }
      if (status === 403 && /just a moment|cloudflare|cf-chl/i.test(details ?? '')) {
        return `${host} is serving a Cloudflare challenge (HTTP 403); these episodes last minutes, retry shortly`
      }
      // viem JSON-stringifies a non-JSON body, so an HTML page arrives as "\"<!DOCTYPE html>...".
      const d = details && !/^"?\s*</.test(details) ? `: ${details.slice(0, 120)}` : ''
      return `${host} returned HTTP ${status ?? 'error'}${d}`
    }
    if (name === 'TimeoutError') return 'RPC request timed out'
  }
  const top = causeChain(err)[0]
  const msg =
    typeof top === 'string'
      ? top
      : ((top as { shortMessage?: string } | null)?.shortMessage ?? (top as Error | null)?.message ?? String(top))
  return (msg.split('\n')[0] ?? '').slice(0, 200)
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
      if (!isTransient(err)) return null
      if (i < attempts - 1) await sleep(150 * 2 ** i)
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
  /**
   * null when decimals() could not be read.
   *
   * STALENESS DOES NOT DEPEND ON THIS. `updatedAt` came back; only the exponent needed to turn
   * `answer` into a dollar figure is missing. An earlier fix made readFeed return null outright in
   * this case to stop decimals() silently defaulting to 8 — correct instinct, wrong blast radius:
   * detect.ts reads a null reading as "no feed here", so an unrelated failed read silently
   * suppressed a TRUE staleness finding. Dropping a true finding because a different call failed
   * is the exact behaviour the retention bug taught this project not to repeat.
   */
  decimals: number | null
  /** null when decimals() could not be read — a wrong exponent is a 10^n price error. */
  price: number | null
  ageSeconds: number
  heartbeat: number
  stale: boolean
  /** False when the answer is non-positive, the round never completed, or decimals is unknown. */
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
  // A missing decimals() read is NOT 8 by assumption — a wrong exponent is a 10^n price error.
  // But it is also not a reason to discard the round data we DID read: updatedAt is what staleness
  // is measured against, and it arrived. So the price becomes null and the reading survives.
  const d = await rawCall(aggregatorV3Abi, proxy, 'decimals', blockNumber)
  const decimals = d ? Number(d.decoded as number) : null
  const ageSeconds = nowSeconds - Number(updatedAt)
  return {
    roundId,
    answeredInRound,
    answer,
    updatedAt,
    decimals,
    price: decimals === null ? null : Number(answer) / 10 ** decimals,
    ageSeconds,
    heartbeat,
    // With the delivery grace from sources.ts, as truePosition applies it: an on-schedule feed
    // lands up to ~26s after its heartbeat, and a strict comparison called that an incident.
    stale: pastHeartbeat(ageSeconds, heartbeat),
    /** A non-positive answer is not a price, and an incomplete round carries an older one. */
    usable: decimals !== null && answer > 0n && answeredInRound >= roundId,
    raw: r.raw,
  }
}

export interface TokenReading {
  multiplier: bigint
  multiplierFloat: number
  /** null when the read failed. NOT 18 by assumption. */
  decimals: number | null
  /** null when the read failed. NOT the same as a zero supply. */
  totalSupply: bigint | null
  oraclePaused: boolean | null
  pendingMultiplier: bigint | null
  effectiveAt: bigint | null
  rawMultiplier: string
  rawTotalSupply: string | null
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
    /**
     * null when the read failed, NOT 18 by assumption.
     *
     * readFeed was changed to stop defaulting decimals() to 8 because a wrong exponent is a 10^n
     * error; this defaulted to 18 for the same reason and was left alone. Every Robinhood Stock
     * Token is in fact 18dp, so the default was right in practice and wrong in principle — and a
     * scaling assumption that happens to hold is exactly the kind that stops holding quietly.
     */
    decimals: dec ? Number(dec.decoded as number) : null,
    /**
     * null when the read FAILED — distinct from a genuine zero supply.
     *
     * This was `ts ? ... : 0n` paired with `rawTotalSupply: ts?.raw ?? '0x'`, so a transient RPC
     * failure produced the citation `totalSupply() == 0` carrying the literal bytes `0x`. Those
     * bytes were never returned by anything: the verifier re-fetches, gets the real supply,
     * mismatches, and drops the ENTIRE finding — including its valid uiMultiplier citation. So one
     * flaky call discredited a true finding, and in the meantime the project's central claim,
     * that every published byte was fetched from chain state, was false for that citation.
     */
    totalSupply: ts ? (ts.decoded as bigint) : null,
    oraclePaused: paused ? (paused.decoded as boolean) : null,
    pendingMultiplier: pend ? (pend.decoded as bigint) : null,
    effectiveAt: eff ? (eff.decoded as bigint) : null,
    rawMultiplier: m.raw,
    /** null when the read failed, so no caller can cite bytes that were never returned. */
    rawTotalSupply: ts?.raw ?? null,
    rawPendingMultiplier: pend?.raw ?? null,
    rawEffectiveAt: eff?.raw ?? null,
    rawOraclePaused: paused?.raw ?? null,
  }
}
