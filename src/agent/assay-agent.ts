import { Agent } from '@openserv-labs/sdk'
import { z } from 'zod'
import { checksumAddress } from 'viem'
import { truePositionFor, checkSymbolSummary, auditContract } from '../lib/surface.js'
import { fetchRhAssets } from '../lib/sources.js'
import { didYouMean } from '../lib/position.js'
import { isTransient, describeRpcError } from '../sweep/oracle.js'
import { isNamedIntegrator } from '../lib/redact.js'
import { PAID_ENDPOINTS } from '../lib/endpoints.js'

/**
 * The ASSAY agent as exposed on the OpenServ marketplace.
 *
 * Two capabilities are sold through OpenServ x402 triggers (see lib/endpoints.ts): true_position
 * at $0.01, cheap enough that an agent can call it before EVERY valuation, and check_contract at
 * $0.25, a named audit of one counterparty. check_symbol has no paywall of its own.
 *
 * Every read here is of public Robinhood Chain state, so the host that runs this holds no signing
 * key (see scripts/serve-remote.ts).
 */
export const assayAgent = new Agent({
  systemPrompt: [
    'You are ASSAY, an independent valuation-integrity service for agents operating on',
    'Robinhood Chain (EIP-155 chain 4663).',
    '',
    'Robinhood Stock Tokens implement ERC-8056 scaled UI amounts: a corporate action moves',
    'uiMultiplier(), not balances. Therefore balanceOf() is NOT a share count, and mixing an',
    'off-chain SHARE price with an on-chain TOKEN quantity produces an error equal to the',
    'multiplier. The Chainlink feed already returns a multiplier-adjusted TOKEN price, so',
    'balanceOf() * feedPrice is correct for token value and the multiplier must NOT be applied',
    'again.',
    '',
    'You never invent a number. Every value you report comes from a tool result. When a tool',
    'returns a refusalReason, you lead with it and you do not soften it: the caller is about to',
    'move money. Report values exactly as returned, including the confidence field. When a tool',
    'returns ok:false, return that error as it is; do not retry it with guessed inputs.',
  ].join('\n'),
})

/**
 * THE BUYER PAYS BEFORE THIS RUNS.
 *
 * OpenServ answers an unpaid POST with a 402 whatever its payload: `{"symbol":"ZZZNOTREAL",
 * "holder":"not-an-address"}` and a payload with no address at all both got a payment challenge.
 * So a typo is a paid call, and what the buyer got back for it was whatever the runtime made of a
 * thrown ZodError or "unknown symbol" exception. Every outcome now comes back as JSON the buyer can
 * act on: the answer, or `ok: false` with a class, a message, a near miss and whether a retry can
 * help. Inputs are checked here rather than by a zod regex for that reason: a regex failure is
 * thrown by the SDK before run() is reached, and cannot be answered.
 */
export type ErrorClass = 'BAD_INPUT' | 'BAD_ADDRESS' | 'UNKNOWN_SYMBOL' | 'UPSTREAM_UNAVAILABLE' | 'INTERNAL'

export interface CapabilityError {
  ok: false
  errorClass: ErrorClass
  field?: string
  message: string
  didYouMean?: string | null
  retryable: boolean
}

const reject = (errorClass: ErrorClass, field: string, message: string, extra: Partial<CapabilityError> = {}) =>
  ({ ok: false, errorClass, field, message, retryable: false, ...extra }) satisfies CapabilityError

/** Enough of a bad input to recognise it in a reply or a log line, and no more. */
const preview = (v: unknown) => JSON.stringify(String(v).slice(0, 48))

/**
 * A Robinhood Chain address, or the reason it is not one.
 *
 * Mixed case is an EIP-55 checksum, and a wrong one almost always means a mistyped character; an
 * audit of the neighbouring address is a paid answer to a question nobody asked. All-lowercase and
 * all-uppercase carry no checksum and are accepted as they are.
 */
export function checkAddressInput(
  field: 'holder' | 'address',
  raw: unknown,
): { ok: true; address: `0x${string}` } | CapabilityError {
  if (typeof raw !== 'string') return reject('BAD_INPUT', field, `${field} is required, as a string.`)
  const v = raw.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    return reject(
      'BAD_ADDRESS',
      field,
      `${field} must be a 0x-prefixed, 40-hex-character address on Robinhood Chain (4663); got ${preview(raw)}.`,
    )
  }
  const hex = v.slice(2)
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase()
  if (mixed && checksumAddress(v as `0x${string}`) !== v) {
    return reject(
      'BAD_ADDRESS',
      field,
      `${field} ${v} fails its EIP-55 checksum, which usually means a mistyped character. ` +
        `Copy it again, or send it all-lowercase to skip the checksum.`,
    )
  }
  return { ok: true, address: checksumAddress(v as `0x${string}`) }
}

/** The registry's spelling of a Stock Token ticker, or the reason there is none. */
export async function resolveSymbolInput(raw: unknown): Promise<{ ok: true; symbol: string } | CapabilityError> {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!/^[A-Za-z0-9.-]{1,16}$/.test(v)) {
    return reject(
      'BAD_INPUT',
      'symbol',
      `symbol must be a Robinhood Stock Token ticker such as NVDA, SPY or CRWD; got ${preview(raw)}.`,
    )
  }
  // The same 60s-cached registry truePosition reads, so this costs no extra round trip.
  const known = (await fetchRhAssets()).map((a) => a.tokenSymbol)
  const match = known.find((s) => s.toUpperCase() === v.toUpperCase())
  if (match) return { ok: true, symbol: match }
  const near = didYouMean(v, known)
  return reject(
    'UNKNOWN_SYMBOL',
    'symbol',
    `${v} is not a Robinhood Stock Token on chain 4663` + (near ? ` — did you mean ${near}?` : '.'),
    { didYouMean: near },
  )
}

/** Any failure after the inputs passed, as an answer rather than an exception. */
export function failure(err: unknown): CapabilityError {
  const message = describeRpcError(err)
  // auditContract reports a failed getCode as "could not read code at ..." rather than rethrowing
  // the RPC error, so the class has to be recovered from its text.
  if (isTransient(err) || /could not read/i.test(message)) {
    return {
      ok: false,
      errorClass: 'UPSTREAM_UNAVAILABLE',
      message: `Robinhood Chain could not be read: ${message}. Nothing was concluded from a partial read.`,
      retryable: true,
    }
  }
  return { ok: false, errorClass: 'INTERNAL', message, retryable: false }
}

/**
 * The backstop over the whole capability. truePosition keeps its own 40s deadline; auditContract
 * and a live sweep have none, and x402's authorization window is 60s.
 */
const CAPABILITY_DEADLINE_MS = 45_000

function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

const PRICE_USD: Record<string, number> = {
  true_position: PAID_ENDPOINTS.truePosition.priceUsd,
  check_contract: PAID_ENDPOINTS.checkContract.priceUsd,
}

/** Characters that cannot break a log line or forge a field. */
const clean = (v: unknown) =>
  v === undefined || v === null ? '-' : String(v).replace(/[^\w.:-]/g, '?').slice(0, 64) || '-'

/**
 * One line per request, so a payment can be matched to an answer.
 *
 * ~40 hours of agent.log held no trace of any paid call: a $0.25 settlement on Base had no
 * corresponding line, so "I paid and got nothing" could be neither confirmed nor refuted. The
 * workspace and task ids join a line to OpenServ's own task history, which remains the record of
 * truth for a dispute. The action's update tokens are never written.
 */
function logRequest(
  capability: string,
  input: Record<string, unknown>,
  outcome: string,
  ms: number,
  action: unknown,
) {
  const a = (action ?? {}) as { workspace?: { id?: unknown }; task?: { id?: unknown } }
  const price = PRICE_USD[capability]
  console.log(
    [
      new Date().toISOString(),
      'request',
      `capability=${capability}`,
      ...(price !== undefined ? [`usd=${price}`] : []),
      ...Object.entries(input).map(([k, v]) => `${k}=${clean(v)}`),
      `outcome=${outcome}`,
      `ms=${ms}`,
      `workspace=${clean(a.workspace?.id)}`,
      `task=${clean(a.task?.id)}`,
    ].join(' '),
  )
}

/** Run one capability: bounded, logged, and always answered in JSON. */
async function serve(
  capability: string,
  input: Record<string, unknown>,
  action: unknown,
  work: () => Promise<{ body: unknown; outcome: string }>,
): Promise<string> {
  const started = Date.now()
  let body: unknown
  let outcome: string
  try {
    ;({ body, outcome } = await withinDeadline(work(), CAPABILITY_DEADLINE_MS))
  } catch (err) {
    const f = failure(err)
    body = f
    outcome = `error class=${f.errorClass}`
  }
  logRequest(capability, input, outcome, Date.now() - started, action)
  return JSON.stringify(body, null, 2)
}

const rejected = (e: CapabilityError) => ({ body: e, outcome: `rejected class=${e.errorClass}` })

export function runTruePosition(args: { symbol?: unknown; holder?: unknown }, action: unknown): Promise<string> {
  return serve('true_position', { symbol: args.symbol, holder: args.holder }, action, async () => {
    const holder = checkAddressInput('holder', args.holder)
    if (!holder.ok) return rejected(holder)
    const symbol = await resolveSymbolInput(args.symbol)
    if (!symbol.ok) return rejected(symbol)
    const p = await truePositionFor(symbol.symbol, holder.address)
    return { body: p, outcome: `ok confidence=${p.confidence}${p.pending.newUIMultiplier ? ' pending' : ''}` }
  })
}

/**
 * A live sweep of one asset. Rows that name a third-party contract are withheld here as on every
 * other unpaid surface (lib/redact.ts); a name is what the $0.25 check_contract sells.
 */
export function runCheckSymbol(args: { symbol?: unknown }, action: unknown): Promise<string> {
  return serve('check_symbol', { symbol: args.symbol }, action, async () => {
    const symbol = await resolveSymbolInput(args.symbol)
    if (!symbol.ok) return rejected(symbol)
    const s = await checkSymbolSummary(symbol.symbol)
    if (!('findings' in s) || !s.findings) return { body: s, outcome: 'ok' }
    const findings = s.findings.filter((f) => !isNamedIntegrator(f))
    return { body: { ...s, published: findings.length, findings }, outcome: `ok published=${findings.length}` }
  })
}

export function runCheckContract(args: { address?: unknown }, action: unknown): Promise<string> {
  return serve('check_contract', { address: args.address }, action, async () => {
    const address = checkAddressInput('address', args.address)
    if (!address.ok) return rejected(address)
    const r = await auditContract(address.address)
    return { body: r, outcome: `ok verdict=${r.verdict}` }
  })
}

assayAgent.addCapability({
  name: 'true_position',
  description:
    'Return the corrected position for a holder of a Robinhood Chain Stock Token: raw balance, ' +
    'token decimals, uiMultiplier, share-equivalents, the multiplier-adjusted Chainlink token ' +
    'price, the derived underlying share price, the correct position value, oracle-hygiene flags ' +
    '(feed age vs heartbeat, oraclePaused), any scheduled ERC-8056 multiplier change ' +
    '(newUIMultiplier/effectiveAt) with a warning, and an explicit refusalReason when the reading ' +
    'is unsafe to act on. Every read is taken at the blockNumber it reports. Bad input returns ' +
    'ok:false with an errorClass and, for a mistyped ticker, didYouMean.',
  inputSchema: z.object({
    symbol: z.string().describe('Stock Token ticker, e.g. NVDA, SPY, CRWD'),
    holder: z.string().describe('Holder address on Robinhood Chain: 0x followed by 40 hex characters'),
  }),
  run: ({ args, action }) => runTruePosition(args, action),
})

assayAgent.addCapability({
  name: 'check_symbol',
  description:
    'Run a fresh, byte-verified integrity sweep for one Robinhood Chain Stock Token at the ' +
    'current block and return the published findings. Every citation is re-fetched and ' +
    'byte-compared before it is returned. Findings that name a third-party contract are withheld; ' +
    'check_contract answers for one named address.',
  inputSchema: z.object({
    symbol: z.string().describe('Stock Token ticker, e.g. NVDA, SPY, CRWD'),
  }),
  run: ({ args, action }) => runCheckSymbol(args, action),
})

assayAgent.addCapability({
  name: 'check_contract',
  description:
    'Audit any address on Robinhood Chain 4663 that holds ERC-8056 Stock Tokens. Returns whether ' +
    'its deployed bytecode references uiMultiplier() — resolving EIP-1967, beacon and EIP-1167 ' +
    'proxies to the implementation before deciding — plus the divergent-multiplier Stock Tokens ' +
    'it holds and the share-equivalents unaccounted for if those balances are read as share ' +
    'counts. NOT_AWARE means the call cannot be made from this bytecode, NOT that the contract ' +
    'misvalues anything. AMM pools, pool managers and custody, executor or distributor contracts ' +
    'hold Stock Tokens without valuing them and return NOT_APPLICABLE with their role. An ' +
    'unresolvable proxy returns PROXY_UNRESOLVED and no verdict.',
  inputSchema: z.object({
    address: z.string().describe('Address on Robinhood Chain 4663: 0x followed by 40 hex characters'),
  }),
  run: ({ args, action }) => runCheckContract(args, action),
})
