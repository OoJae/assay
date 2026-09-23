import { decodeFunctionResult, encodeFunctionData, keccak256, toFunctionSelector } from 'viem'
import { rhClient } from '../lib/chains.js'
import { stockTokenAbi } from '../lib/abis.js'
import type { ChainlinkFeed } from '../lib/sources.js'
import { evidence, isTransient, rawCall, readFeed } from './oracle.js'
import type { Evidence, Finding } from './types.js'
import { EIP1967_IMPLEMENTATION_SLOT } from '../verify/index.js'

/**
 * THE INTEGRATOR AUDIT.
 *
 * ASSAY audits 195 assets, every one of which behaves exactly as ERC-8056 specifies. The exposure
 * is not in the assets — it is in the contracts that HOLD them and read balanceOf() as a share
 * count. Measured on chain 4663: of the addresses touching SPY and NVDA over ~1.5 hours, roughly
 * 80% are contracts, and none of the substantial ones sampled referenced uiMultiplier() at all.
 *
 * Every Finding this project publishes already carries an `affectedParty` reading "any integrator
 * that presents balanceOf() as a share count". That party is on-chain and countable. This module
 * is the difference between describing a hypothetical victim and checking a real one.
 *
 * WHAT THE EVIDENCE CAN AND CANNOT SUPPORT — this governs every word of the output:
 *
 *   CAN:    "this contract's deployed bytecode does not contain the uiMultiplier() selector,
 *            therefore it cannot call uiMultiplier() directly."  (eth_getCode, byte-verifiable)
 *   CANNOT: "this contract misvalues its position."  A router that only moves tokens never needs
 *            the multiplier and is not wrong to lack it.
 *
 * So the finding states the exposure conditionally and says so on its face. This is the same
 * discipline that renamed SHARE_COUNT_MISREPORT to SHARE_COUNT_MISREAD_RISK: naming a party that
 * did nothing wrong is the most damaging error this tool can make.
 */

export const UI_MULTIPLIER_SELECTOR = toFunctionSelector('function uiMultiplier() view returns (uint256)')
export const ORACLE_PAUSED_SELECTOR = toFunctionSelector('function oraclePaused() view returns (bool)')

/**
 * Below this, bytecode is a proxy, a stub, or a wallet — too small to contain valuation logic, and
 * the selector test says nothing useful about it. Measured: the real integrators on this chain are
 * 4.6KB-21.6KB; the things under 2KB were EIP-1167 minimal proxies (45 bytes) and stubs (23-609).
 */
export const MIN_LOGIC_BYTES = 2_048

/**
 * The materiality floor for NAMING a holding.
 *
 * The committed snapshot named three holdings titled "holds 0.0000 …" and several worth $7-$50.
 * Naming a party over exposure that rounds to nothing is noise at best and unfair at worst. A
 * priced holding is named from $1,000; an unpriced one (most divergent tokens have no feed) from
 * 0.01 share-equivalents unaccounted. Anything below is still counted in the aggregate.
 */
export const NAMED_MIN_USD = 1_000
export const NAMED_MIN_SHARES = 0.01

export type IntegratorVerdict =
  /** Bytecode references uiMultiplier(). Not exposed. */
  | 'AWARE'
  /** Substantial bytecode, selector absent, not a proxy, no recognised role. The only verdict that gets named. */
  | 'NOT_AWARE'
  /**
   * Recognised by the selectors it IMPLEMENTS as an AMM pool, a pool manager, a custody/executor
   * wallet or a distributor. None of those keeps share accounting, so lacking uiMultiplier() is
   * expected. NO CLAIM IS MADE, and it is never named.
   */
  | 'NOT_APPLICABLE'
  /** A proxy whose implementation could not be resolved, or a proxy read that failed. NO CLAIM IS MADE. */
  | 'PROXY_UNRESOLVED'
  /** No code at all at this block — an externally owned account, or nothing deployed here. */
  | 'EOA'
  /** Has code but too little to hold valuation logic. */
  | 'TOO_SMALL'

/** What a NOT_APPLICABLE contract was recognised as. */
export type IntegratorRole = 'AMM_POOL' | 'AMM_POOL_MANAGER' | 'CUSTODY' | 'DISTRIBUTOR'

export const INTEGRATOR_ROLES: readonly IntegratorRole[] = ['AMM_POOL', 'AMM_POOL_MANAGER', 'CUSTODY', 'DISTRIBUTOR']

export interface IntegratorReading {
  address: `0x${string}`
  verdict: IntegratorVerdict
  codeSize: number
  codeHash: `0x${string}`
  /** Set when this address is a proxy and the implementation was resolved. */
  implementation?: `0x${string}`
  implementationCodeHash?: `0x${string}`
  /** How the implementation was found, for the statement to quote honestly. */
  proxyKind?: 'eip1967' | 'eip1167' | 'eip1967-beacon'
  /** The beacon, when the implementation was reached through one. */
  beacon?: `0x${string}`
  /** The raw slot words and beacon.implementation() return, so each link can be cited as read. */
  implementationSlotRaw?: string
  beaconSlotRaw?: string
  beaconImplementationRaw?: string
  /** Size of the bytecode the selector test actually ran against. */
  testedCodeSize?: number
  hasMultiplierSelector: boolean
  hasPausedSelector: boolean
  /** NOT_APPLICABLE only: what the contract was recognised as, and by which implemented selectors. */
  role?: IntegratorRole
  roleSelectors?: string[]
  /** PROXY_UNRESOLVED only: which read failed or came back unusable. */
  unresolvedReason?: string
}

/**
 * EIP-1967 BEACON slot, and the `implementation()` selector the stub calls on the beacon.
 *
 * This is not an academic case on this chain: the Robinhood Stock Tokens are themselves beacon
 * proxies — SGOV's own address is a 283-byte stub whose beacon slot points at
 * 0xe10b6f6b275de231345c20d14ab812db62151b00. Without resolving beacons, every such contract reads
 * as a 283-byte stub with no selectors, and the classifier would either withhold everything
 * interesting or — far worse — report a perfectly multiplier-aware contract as NOT_AWARE.
 */
const EIP1967_BEACON_SLOT =
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as const
const IMPLEMENTATION_SELECTOR = '0x5c60da1b' as const

/**
 * The COMPLETE runtime of an EIP-1167 minimal proxy, and of its PUSH0 form (ERC-7511).
 *
 * Matched whole, never as fragments. Looking for the prefix and the suffix anywhere in the code
 * matched every OpenZeppelin Clones FACTORY, which embeds both constants to deploy clones, and
 * read the next 40 hex characters as an "implementation" — the paid answer then printed
 * implementations like 0x0000008060f01b17… for any clone factory.
 */
const EIP1167_RUNTIME = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/
const ERC7511_RUNTIME = /^0x365f5f375f5f365f73([0-9a-f]{40})5af43d5f5f3e5f3d91602a57fd5bf3$/

/** The implementation inlined in a minimal proxy, or null when this is not exactly one. */
function minimalProxyImplementation(code: string): `0x${string}` | null {
  const c = code.toLowerCase()
  const m = EIP1167_RUNTIME.exec(c) ?? ERC7511_RUNTIME.exec(c)
  return m ? (`0x${m[1]}` as `0x${string}`) : null
}

export interface SelectorScan {
  /** Every selector the code pushes as an instruction operand: called, compared or stored. */
  pushed: Set<string>
  /** The subset the dispatcher compares calldata against — the functions this code IMPLEMENTS. */
  dispatched: Set<string>
}

/**
 * The selectors in a piece of runtime bytecode, read as INSTRUCTIONS rather than as text.
 *
 * `code.includes('a60bf13d')` matched at any nibble offset, inside other constants and inside the
 * CBOR metadata tail, so a counterparty could pass the AWARE test by embedding the selector as a
 * constant, and a random byte sequence could pass it by accident. This walks the code opcode by
 * opcode, so a selector counts only as the operand of a real PUSH4, and stops at the metadata.
 *
 * Also counted: a PUSH32 whose operand is the selector followed by 28 zero bytes. The via-IR
 * optimiser folds `shl(224, selector)` into exactly that constant — measured on this chain, the v4
 * PoolManager and an executor wallet carry their error selectors that way — and missing a call
 * written in that form would turn a multiplier-aware contract into a NOT_AWARE one.
 *
 * `dispatched` is narrower: a selector pushed and then compared with EQ (optionally after one DUP),
 * which is the shape of solc's function dispatcher. A router that CALLS a pool's swap() pushes the
 * same selector, then shifts it into calldata; only the pool compares it. Every selector looked up
 * here has a nonzero first byte, so it is always a full PUSH4 and never a shorter push.
 */
export function scanSelectors(code: string): SelectorScan {
  const b = Buffer.from(code.replace(/^0x/i, ''), 'hex')
  let end = b.length
  // Solidity appends CBOR metadata and ends the code with its length. It is data, not code. Cut
  // only when the tail really parses as that map (a small map whose first key is "ipfs", "bzzr0",
  // "bzzr1", "solc" or "experimental"): cutting real code by mistake could hide a selector.
  if (end >= 2) {
    const len = b.readUInt16BE(end - 2)
    const start = end - 2 - len
    if (len <= 256 && start >= 0 && b[start]! >= 0xa1 && b[start]! <= 0xa5 && [0x64, 0x65, 0x6c].includes(b[start + 1]!))
      end = start
  }
  const pushed = new Set<string>()
  const dispatched = new Set<string>()
  for (let i = 0; i < end; ) {
    const op = b[i]!
    if (op < 0x60 || op > 0x7f) {
      i++
      continue
    }
    const n = op - 0x5f
    const operand = b.subarray(i + 1, i + 1 + n)
    const next = i + 1 + n
    if (n === 4 && operand.length === 4) {
      const s = `0x${operand.toString('hex')}`
      pushed.add(s)
      const a = b[next]
      if (next < end && (a === 0x14 || (a !== undefined && a >= 0x80 && a <= 0x8f && b[next + 1] === 0x14)))
        dispatched.add(s)
    } else if (n === 32 && operand.length === 32 && operand.subarray(4).every((x) => x === 0)) {
      pushed.add(`0x${operand.subarray(0, 4).toString('hex')}`)
    }
    i = next
  }
  return { pushed, dispatched }
}

const sel = (signature: string) => toFunctionSelector(`function ${signature}`) as string

/**
 * Contracts whose role has no share accounting in it, recognised by the functions they IMPLEMENT.
 *
 * Measured: 99.6% of the dollar headline the wall published as "held by contracts that cannot call
 * uiMultiplier()" sat in six Uniswap-V3-style pools, the v4 PoolManager and one executor wallet, and
 * the flagship $0.25 settlement answered NOT_AWARE about a V3 pool. A pool prices its reserves per
 * token; it never converts a balance into shares, so lacking the multiplier is expected, not a risk.
 * Each fingerprint below was checked against the dispatcher of a contract named in that snapshot,
 * except Safe's, which was checked against the Safe 1.4.1 singletons on Base.
 */
const ROLE_FINGERPRINTS: Array<{ role: IntegratorRole; implements: string[] }> = [
  // Uniswap v4 PoolManager: one singleton holds every pool's reserves.
  { role: 'AMM_POOL_MANAGER', implements: ['unlock(bytes)', 'settle()', 'take(address,address,uint256)'] },
  // Uniswap V3 and its forks.
  { role: 'AMM_POOL', implements: ['slot0()', 'swap(address,bool,int256,uint160,bytes)'] },
  // Uniswap V2 pairs, and launch pools that expose the same reserve interface.
  { role: 'AMM_POOL', implements: ['getReserves()', 'factory()'] },
  // Safe multisig, and an owner-operated executor whose owner moves tokens with arbitrary calls.
  {
    role: 'CUSTODY',
    implements: ['execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)'],
  },
  { role: 'CUSTODY', implements: ['executeGeneral(address,bytes)'] },
  // Merkle distributors pay out amounts fixed off-chain against a proof: Uniswap's, and the epoch form.
  { role: 'DISTRIBUTOR', implements: ['claim(uint256,address,uint256,bytes32[])'] },
  { role: 'DISTRIBUTOR', implements: ['claim(uint256,address,uint256,uint256,bytes32[])'] },
]

/**
 * Selectors that mean a contract may value or account for shares. Any one of them, dispatched or
 * called, vetoes NOT_APPLICABLE: a vault that also exposes an execute() is still a vault, and
 * falling back to NOT_AWARE there is the direction that keeps the aggregate honest.
 */
const VALUATION_SIGNATURES = [
  'totalAssets()',
  'convertToShares(uint256)',
  'convertToAssets(uint256)',
  'previewRedeem(uint256)',
  'previewDeposit(uint256)',
  'pricePerShare()',
  'getPricePerFullShare()',
  'latestRoundData()',
]

const VALUATION_SELECTORS = VALUATION_SIGNATURES.map(sel)
const ROLE_SELECTORS = ROLE_FINGERPRINTS.map((f) => ({ ...f, selectors: f.implements.map(sel) }))

function recogniseRole(scan: SelectorScan): { role: IntegratorRole; roleSelectors: string[] } | null {
  if (VALUATION_SELECTORS.some((s) => scan.pushed.has(s))) return null
  for (const f of ROLE_SELECTORS) {
    if (f.selectors.every((s) => scan.dispatched.has(s))) return { role: f.role, roleSelectors: f.implements }
  }
  return null
}

const hexBlock = (blockNumber: bigint) => `0x${blockNumber.toString(16)}`

async function getCode(address: `0x${string}`, blockNumber: bigint): Promise<string> {
  return (await rhClient.request({
    method: 'eth_getCode',
    params: [address, hexBlock(blockNumber)],
  } as never)) as string
}

async function getStorageAt(address: `0x${string}`, slot: string, blockNumber: bigint): Promise<string> {
  return (await rhClient.request({
    method: 'eth_getStorageAt',
    params: [address, slot, hexBlock(blockNumber)],
  } as never)) as string
}

/** The address in the low 20 bytes of a 32-byte word, or null when the word is zero or short. */
function addressWord(word: string | undefined): `0x${string}` | null {
  if (!word || word.length < 66 || !/[1-9a-f]/i.test(word.slice(26, 66))) return null
  return `0x${word.slice(26, 66)}` as `0x${string}`
}

/**
 * Classify one address.
 *
 * PROXIES ARE RESOLVED OR WITHHELD, never guessed. A proxy's own bytecode is a delegatecall stub
 * that contains no application selectors at all, so a naive selector test would report every proxy
 * on the chain as NOT_AWARE — the single most likely way this module could libel someone.
 *
 * FAIL CLOSED. Any read in the resolution chain that throws ends in PROXY_UNRESOLVED. The slot
 * reads used to swallow their errors ("treated as unresolved below", which nothing below did), so
 * one transient 403 on the implementation slot sent a proxy's own stub to the selector test and a
 * large enough stub came back NOT_AWARE — reproduced offline, and served by the paid audit with
 * conclusive:true.
 *
 * Precedence: AWARE (the logic references uiMultiplier()) > NOT_APPLICABLE (a recognised role with
 * no share accounting) > TOO_SMALL > NOT_AWARE.
 */
export async function classifyIntegrator(
  address: `0x${string}`,
  blockNumber: bigint,
): Promise<IntegratorReading | null> {
  let code: string
  try {
    code = await getCode(address, blockNumber)
  } catch {
    return null
  }
  const codeSize = Math.max(0, (code.length - 2) / 2)
  const codeHash = keccak256(code as `0x${string}`)
  const base: IntegratorReading = {
    address,
    verdict: 'EOA',
    codeSize,
    codeHash,
    hasMultiplierSelector: false,
    hasPausedSelector: false,
  }
  if (codeSize === 0) return base
  const unresolved = (reason: string, extra: Partial<IntegratorReading> = {}): IntegratorReading => ({
    ...base,
    ...extra,
    verdict: 'PROXY_UNRESOLVED',
    unresolvedReason: reason,
  })

  // --- Proxy resolution, before any selector conclusion is drawn ---
  let implAddr = minimalProxyImplementation(code)
  let proxyKind: IntegratorReading['proxyKind'] = implAddr ? 'eip1167' : undefined
  let beacon: `0x${string}` | undefined
  let implementationSlotRaw: string | undefined
  let beaconSlotRaw: string | undefined
  let beaconImplementationRaw: string | undefined

  if (!implAddr) {
    let slot: string
    try {
      slot = await getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT, blockNumber)
    } catch {
      return unresolved('the EIP-1967 implementation slot could not be read')
    }
    implAddr = addressWord(slot)
    if (implAddr) {
      proxyKind = 'eip1967'
      implementationSlotRaw = slot
    }
  }

  if (!implAddr) {
    let slot: string
    try {
      slot = await getStorageAt(address, EIP1967_BEACON_SLOT, blockNumber)
    } catch {
      return unresolved('the EIP-1967 beacon slot could not be read')
    }
    beacon = addressWord(slot) ?? undefined
    if (beacon) {
      beaconSlotRaw = slot
      let res: string
      try {
        res = (await rhClient.request({
          method: 'eth_call',
          params: [{ to: beacon, data: IMPLEMENTATION_SELECTOR }, hexBlock(blockNumber)],
        } as never)) as string
      } catch {
        return unresolved('the beacon did not answer implementation()', { proxyKind: 'eip1967-beacon', beacon })
      }
      implAddr = addressWord(res)
      // Beacon present but unreadable: NO CLAIM.
      if (!implAddr)
        return unresolved('the beacon returned no implementation', { proxyKind: 'eip1967-beacon', beacon })
      beaconImplementationRaw = res
      proxyKind = 'eip1967-beacon'
    }
  }

  let logic = code
  let testedCodeSize = codeSize
  let proxied: Partial<IntegratorReading> = {}
  if (implAddr) {
    const linked = { proxyKind, beacon, implementationSlotRaw, beaconSlotRaw, beaconImplementationRaw }
    let implCode: string
    try {
      implCode = await getCode(implAddr, blockNumber)
    } catch {
      return unresolved('the implementation code could not be read', { ...linked, implementation: implAddr })
    }
    const implSize = Math.max(0, (implCode.length - 2) / 2)
    if (implSize === 0)
      return unresolved('the implementation has no code', { ...linked, implementation: implAddr })
    logic = implCode
    testedCodeSize = implSize
    proxied = { ...linked, implementation: implAddr, implementationCodeHash: keccak256(implCode as `0x${string}`) }
  }

  // --- The selector test, against the logic that actually runs ---
  const scan = scanSelectors(logic)
  const reading: IntegratorReading = {
    ...base,
    ...proxied,
    testedCodeSize,
    hasMultiplierSelector: scan.pushed.has(UI_MULTIPLIER_SELECTOR),
    hasPausedSelector: scan.pushed.has(ORACLE_PAUSED_SELECTOR),
  }
  if (reading.hasMultiplierSelector) return { ...reading, verdict: 'AWARE' }
  const role = recogniseRole(scan)
  if (role) return { ...reading, verdict: 'NOT_APPLICABLE', ...role }
  if (testedCodeSize < MIN_LOGIC_BYTES) return { ...reading, verdict: 'TOO_SMALL' }
  return { ...reading, verdict: 'NOT_AWARE' }
}

/**
 * The citations a reading rests on: the tested bytecode and every link from the named address to
 * it. Pass the holding as well and its balance, multiplier and price are cited too.
 *
 * The code citation alone proved "some bytecode lacks a selector", not "this address runs that
 * bytecode and holds this much": a beacon proxy's finding cited only its implementation, and the
 * balance and multiplier it quoted carried no citation at all.
 */
export function integratorEvidence(
  r: IntegratorReading,
  blockNumber: bigint,
  observedAt: string,
  holding?: IntegratorExposure,
): Evidence[] {
  return [...codeEvidence(r, blockNumber, observedAt), ...(holding ? holdingEvidence(holding, observedAt) : [])]
}

function codeEvidence(r: IntegratorReading, blockNumber: bigint, observedAt: string): Evidence[] {
  const target = r.implementation ?? r.address
  const hash = r.implementationCodeHash ?? r.codeHash
  const ev = [
    evidence(
      `keccak256(eth_getCode(${target})) == ${hash} — ${r.testedCodeSize ?? r.codeSize} bytes, ` +
        (r.hasMultiplierSelector ? `pushes the ${UI_MULTIPLIER_SELECTOR} selector` : `no ${UI_MULTIPLIER_SELECTOR} selector`),
      target,
      'getCode()',
      hash,
      blockNumber,
      observedAt,
    ),
  ]
  if (r.implementation && r.proxyKind === 'eip1967') {
    ev.push(
      evidence(
        `EIP-1967 implementation slot resolves to ${r.implementation}`,
        r.address,
        'getStorageAt(EIP1967_IMPLEMENTATION)',
        r.implementationSlotRaw ?? `0x${'0'.repeat(24)}${r.implementation.slice(2)}`,
        blockNumber,
        observedAt,
      ),
    )
  }
  if (r.implementation && r.proxyKind === 'eip1167') {
    ev.push(
      evidence(
        `keccak256(eth_getCode(${r.address})) == ${r.codeHash} — an EIP-1167 minimal proxy delegating to ${r.implementation}`,
        r.address,
        'getCode()',
        r.codeHash,
        blockNumber,
        observedAt,
      ),
    )
  }
  if (r.implementation && r.proxyKind === 'eip1967-beacon' && r.beacon && r.beaconSlotRaw && r.beaconImplementationRaw) {
    ev.push(
      evidence(`EIP-1967 beacon slot resolves to ${r.beacon}`, r.address, 'getStorageAt(EIP1967_BEACON)', r.beaconSlotRaw, blockNumber, observedAt),
      {
        ...evidence(`beacon.implementation() == ${r.implementation}`, r.beacon, 'implementation()', r.beaconImplementationRaw, blockNumber, observedAt),
        calldata: IMPLEMENTATION_SELECTOR,
      },
    )
  }
  return ev
}

/** The balance, multiplier and (when priced) feed reads behind one holding, at its own block. */
export function holdingEvidence(h: IntegratorExposure, observedAt: string): Evidence[] {
  const ev: Evidence[] = [
    evidence(`uiMultiplier() == ${h.uiMultiplier}`, h.token, 'uiMultiplier()', h.raw.multiplier, h.blockNumber, observedAt),
    {
      ...evidence(
        `balanceOf(${h.reading.address}) == ${h.raw.balanceWei}`,
        h.token,
        'balanceOf(address)',
        h.raw.balance,
        h.blockNumber,
        observedAt,
      ),
      calldata: h.raw.balanceCalldata,
    },
  ]
  if (h.raw.price) {
    ev.push(
      evidence(
        `latestRoundData() prices ${h.symbol} at ${h.raw.price.usd}`,
        h.raw.price.feed,
        'latestRoundData()',
        h.raw.price.latestRoundData,
        h.blockNumber,
        observedAt,
      ),
    )
  }
  return ev
}

/** A uiMultiplier() read at a pinned block, kept raw so it can be cited. */
export interface MultiplierRead {
  symbol: string
  token: `0x${string}`
  multiplier: bigint
  raw: string
  blockNumber: bigint
}

/**
 * Read uiMultiplier() ON-CHAIN at the block the holding is read at.
 *
 * Both the sweep and the paid audit used the REST registry's `currentMultiplier` here and then
 * published it as "uiMultiplier() = X" under a byte-verified badge, although sources.ts calls REST
 * values untrusted until re-verified, and around a corporate action the two can disagree.
 */
export async function readMultiplier(
  symbol: string,
  token: `0x${string}`,
  blockNumber: bigint,
): Promise<MultiplierRead | null> {
  const r = await rawCall(stockTokenAbi, token, 'uiMultiplier', blockNumber)
  return r ? { symbol, token, multiplier: r.decoded as bigint, raw: r.raw, blockNumber } : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * balanceOf(holder) at a pinned block, raw. null means UNREAD, which is not a zero balance.
 *
 * rawCall takes no arguments, so this is its twin for the one call that needs one, with the same
 * bounded retry on transient faults.
 */
async function readBalance(
  token: `0x${string}`,
  holder: `0x${string}`,
  blockNumber: bigint,
  attempts = 3,
): Promise<{ balance: bigint; raw: string; calldata: `0x${string}` } | null> {
  const calldata = encodeFunctionData({ abi: stockTokenAbi, functionName: 'balanceOf', args: [holder] })
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = (await rhClient.request({
        method: 'eth_call',
        params: [{ to: token, data: calldata }, hexBlock(blockNumber)],
      } as never)) as string
      if (!raw || raw === '0x') return null
      const balance = decodeFunctionResult({ abi: stockTokenAbi, functionName: 'balanceOf', data: raw as `0x${string}` })
      return { balance, raw, calldata }
    } catch (err) {
      if (!isTransient((err as Error).message ?? String(err))) return null
      await sleep(150 * 2 ** i)
    }
  }
  return null
}

/** A usable feed price at the holding's block, kept raw so it can be cited. */
export interface PriceRead {
  usd: number
  feed: `0x${string}`
  latestRoundData: string
}

export interface IntegratorExposure {
  reading: IntegratorReading
  symbol: string
  token: `0x${string}`
  /** The block balance, multiplier and price were all read at. */
  blockNumber: bigint
  /** On-chain uiMultiplier() at `blockNumber`, 1e18 fixed point. */
  uiMultiplier: bigint
  multiplier: number
  tokenUnits: number
  shareEquivalents: number
  /** share-equivalents minus the raw balance. NEGATIVE after a reverse split. */
  sharesUnaccounted: number
  /** (1 - 1/multiplier) x 100. NEGATIVE after a reverse split, where the raw balance overstates. */
  misreadPct: number
  usdHeld: number | null
  /** The bytes behind each figure, for citation. */
  raw: {
    balance: string
    balanceWei: bigint
    balanceCalldata: `0x${string}`
    multiplier: string
    price?: PriceRead
  }
}

/** A holding read that could not complete is not an empty one, and the two must not be confused. */
export type ExposureRead =
  | { status: 'held'; exposure: IntegratorExposure }
  | { status: 'empty' }
  | { status: 'unreadable' }

/** balanceOf x uiMultiplier — the same arithmetic truePosition() sells, applied to a third party. */
export async function integratorExposure(
  reading: IntegratorReading,
  m: MultiplierRead,
  price: PriceRead | null,
): Promise<ExposureRead> {
  const b = await readBalance(m.token, reading.address, m.blockNumber)
  if (!b) return { status: 'unreadable' }
  if (b.balance <= 0n) return { status: 'empty' }
  const tokenUnits = Number(b.balance) / 1e18
  const multiplier = Number(m.multiplier) / 1e18
  const shareEquivalents = tokenUnits * multiplier
  return {
    status: 'held',
    exposure: {
      reading,
      symbol: m.symbol,
      token: m.token,
      blockNumber: m.blockNumber,
      uiMultiplier: m.multiplier,
      multiplier,
      tokenUnits,
      shareEquivalents,
      sharesUnaccounted: shareEquivalents - tokenUnits,
      misreadPct: multiplier > 0 ? (1 - 1 / multiplier) * 100 : 0,
      usdHeld: price ? tokenUnits * price.usd : null,
      raw: {
        balance: b.raw,
        balanceWei: b.balance,
        balanceCalldata: b.calldata,
        multiplier: m.raw,
        ...(price ? { price } : {}),
      },
    },
  }
}

function withPrice(e: IntegratorExposure, price: PriceRead): ExposureRead {
  return { status: 'held', exposure: { ...e, usdHeld: e.tokenUnits * price.usd, raw: { ...e.raw, price } } }
}

/** Above the floor for naming — see NAMED_MIN_USD. */
export function isMaterial(e: IntegratorExposure): boolean {
  return e.usdHeld !== null ? e.usdHeld >= NAMED_MIN_USD : Math.abs(e.sharesUnaccounted) >= NAMED_MIN_SHARES
}

/**
 * Read a feed at a block and keep it only when it is a usable price.
 *
 * `failed` is true when the read itself failed — an unknown price, which is not the same as a
 * token with no feed at all.
 */
export async function readPrice(
  feed: ChainlinkFeed,
  nowSeconds: number,
  blockNumber: bigint,
): Promise<{ price: PriceRead | null; failed: boolean }> {
  const fr = await readFeed(feed.proxyAddress, feed.heartbeat, nowSeconds, blockNumber)
  if (!fr) return { price: null, failed: true }
  if (!fr.usable || fr.price === null) return { price: null, failed: false }
  return { price: { usd: fr.price, feed: feed.proxyAddress, latestRoundData: fr.raw }, failed: false }
}

/** How many reads a single-address audit keeps in flight. Matches the sweep's cohort pre-pass. */
const READ_CONCURRENCY = 10

async function mapBounded<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

export interface HoldingsScan {
  /** Tokens whose on-chain multiplier is not exactly 1.0 at the block — every one was checked. */
  divergent: string[]
  holdings: IntegratorExposure[]
  /** Tokens whose multiplier, balance or feed read FAILED. Their exposure is unknown, not zero. */
  incomplete: string[]
  /** The part of `incomplete` that was not read at all because the deadline passed first. */
  outOfTime: string[]
  /** Tokens held with no usable price, so their dollar value is unknown. */
  unpriced: string[]
}

const OUT_OF_TIME = Symbol('out of time')

/**
 * Start `read` only before the deadline, and stop waiting for it at the deadline.
 *
 * A read still in flight is abandoned, not cancelled: the RPC client has its own timeouts. What
 * matters is that the caller answers on time, with the token named as unread.
 */
async function beforeDeadline<R>(read: () => Promise<R>, deadline: number | undefined): Promise<R | typeof OUT_OF_TIME> {
  if (deadline === undefined) return read()
  const left = deadline - Date.now()
  if (left <= 0) return OUT_OF_TIME
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof OUT_OF_TIME>((resolve) => {
    timer = setTimeout(() => resolve(OUT_OF_TIME), left)
  })
  try {
    return await Promise.race([read(), expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every divergent-multiplier Stock Token one address holds, read at one block.
 *
 * Every token's multiplier is read on-chain, and every token whose multiplier is not exactly 1e18
 * is checked. The paid audit used to apply the sweep's 0.2% cutoff to the REST value, which skipped
 * 25 of the 34 divergent tokens — SPY, NVDA and AAPL among them — and told a holder of only those
 * that it held nothing. One address is cheap enough to check against all of them.
 *
 * Nothing that fails is dropped: a failed read lands in `incomplete`, never in `holdings` as a zero.
 *
 * `deadline` (epoch ms) bounds the whole scan. Checking every token is ~250 reads at 10 in flight:
 * 28.5s measured from a laptop against a 45s capability deadline and x402's 60s, and during a
 * Cloudflare episode each read first spends ~1s on the official RPC's 403 before the fallback. Past
 * the deadline, a paying buyer got UPSTREAM_UNAVAILABLE for a call they had already paid for. Now
 * whatever was not read in time is named in `incomplete` and `outOfTime`, and the answer is
 * returned, inconclusive, on time.
 */
export async function scanHoldings(
  reading: IntegratorReading,
  tokens: Array<{ symbol: string; token: `0x${string}`; feed: ChainlinkFeed | null }>,
  blockNumber: bigint,
  nowSeconds: number,
  deadline?: number,
): Promise<HoldingsScan> {
  const incomplete: string[] = []
  const outOfTime: string[] = []
  const unpriced: string[] = []
  const reads = await mapBounded(
    tokens,
    READ_CONCURRENCY,
    async (t) => ({ t, m: await beforeDeadline(() => readMultiplier(t.symbol, t.token, blockNumber), deadline) }) as const,
  )
  const divergent: Array<{ t: (typeof tokens)[number]; m: MultiplierRead }> = []
  for (const { t, m } of reads) {
    if (m === OUT_OF_TIME) outOfTime.push(t.symbol)
    if (m === OUT_OF_TIME || !m) incomplete.push(t.symbol)
    else if (m.multiplier !== 10n ** 18n) divergent.push({ t, m })
  }
  // The price is read only for tokens actually held, so an audit of an address holding nothing
  // costs one multiplier and one balance read per token.
  const held = await mapBounded(divergent, READ_CONCURRENCY, async ({ t, m }) => {
    const r = await beforeDeadline(async () => {
      const x = await integratorExposure(reading, m, null)
      if (x.status !== 'held' || !t.feed) return { x, priceFailed: false }
      const p = await readPrice(t.feed, nowSeconds, blockNumber)
      return { x: p.price ? withPrice(x.exposure, p.price) : x, priceFailed: p.failed }
    }, deadline)
    return { symbol: t.symbol, r } as const
  })
  const holdings: IntegratorExposure[] = []
  for (const { symbol, r } of held) {
    if (r === OUT_OF_TIME) {
      outOfTime.push(symbol)
      incomplete.push(symbol)
      continue
    }
    if (r.x.status === 'unreadable') incomplete.push(symbol)
    if (r.x.status !== 'held') continue
    holdings.push(r.x.exposure)
    if (r.priceFailed) incomplete.push(symbol)
    if (r.x.exposure.usdHeld === null) unpriced.push(symbol)
  }
  return { divergent: divergent.map((d) => d.t.symbol), holdings, incomplete, outOfTime, unpriced }
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Every address that sent or received this token in the recent past.
 *
 * Log retention on this RPC is deeper than STATE retention, so this reaches further back than a
 * citation can. The window is bounded because the sweep has to finish inside the ~8 minute cadence
 * that keeps citations re-fetchable.
 *
 * `windowsRead` says how far it got. A failure on a later window is retention running out, and what
 * was read is what is reported. A failure on the FIRST window means nothing was read, and it used to
 * come back as an empty set, so an asset whose holders were never looked at was published as
 * scanned with no holders.
 */
export async function recentCounterparties(
  token: `0x${string}`,
  head: bigint,
  windows = 5,
  windowSize = 9_000n,
): Promise<{ addrs: Set<`0x${string}`>; windowsRead: number }> {
  const out = new Set<`0x${string}`>()
  let windowsRead = 0
  for (let i = 0; i < windows; i++) {
    const to = head - BigInt(i) * windowSize
    const from = to - windowSize
    if (from < 0n) break
    try {
      const logs = (await rhClient.request({
        method: 'eth_getLogs',
        params: [
          {
            address: token,
            topics: [TRANSFER_TOPIC],
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          },
        ],
      } as never)) as Array<{ topics: string[] }>
      for (const l of logs) {
        for (const t of l.topics.slice(1, 3)) {
          const a = `0x${t.slice(26)}`.toLowerCase()
          if (a !== `0x${'0'.repeat(40)}`) out.add(a as `0x${string}`)
        }
      }
      windowsRead++
    } catch {
      break // log retention exhausted; what we have is what we report
    }
  }
  return { addrs: out, windowsRead }
}

const ROLE_TEXT: Record<IntegratorRole, string> = {
  AMM_POOL: 'an AMM pool, which prices its reserves per token',
  AMM_POOL_MANAGER: 'an AMM pool manager, a singleton holding the reserves of many pools',
  CUSTODY: 'a custody or executor wallet, whose owner moves tokens through arbitrary calls',
  DISTRIBUTOR: 'a merkle distributor, which pays out amounts fixed off-chain against a proof',
}

/**
 * What a verdict does and does not establish, in words. Always returned with a verdict, because a
 * bare "NOT_AWARE" reads as an accusation and the evidence supports only an absence.
 */
export function verdictInterpretation(r: IntegratorReading): string {
  switch (r.verdict) {
    case 'AWARE':
      return 'This bytecode references uiMultiplier(), so it is capable of making the ERC-8056 correction. That it CAN does not prove it always DOES.'
    case 'NOT_AWARE':
      return 'This bytecode does not reference uiMultiplier(), so it cannot make that call directly. IT MAY NOT NEED TO — a contract that only custodies or routes the token is not wrong to lack it. What is established is the absence of the call, not the presence of a mistake.'
    case 'NOT_APPLICABLE':
      return (
        `Recognised by the functions it implements (${(r.roleSelectors ?? []).join(', ')}) as ` +
        `${r.role ? ROLE_TEXT[r.role] : 'a contract with no share accounting'}. That role converts no ` +
        `balance into shares, so lacking uiMultiplier() is expected. No claim is made against it.`
      )
    case 'PROXY_UNRESOLVED':
      return `Proxy resolution did not complete (${r.unresolvedReason ?? 'implementation unresolved'}), so NO CLAIM IS MADE either way. Unchecked is not disproven.`
    case 'EOA':
      return 'No code at this address on chain 4663 at this block, so there is no contract to inspect. Whatever controls it off-chain cannot be seen from here.'
    case 'TOO_SMALL':
      return 'Too little bytecode to contain valuation logic — typically a stub or an unrecognised proxy. No claim is made.'
  }
}

/**
 * Build the named Finding. Only ever called for a NOT_AWARE holding above the materiality floor.
 *
 * `blockNumber` is the block the code was read at; the holding carries its own.
 */
export function integratorFinding(
  e: IntegratorExposure,
  blockNumber: bigint,
  observedAt: string,
  methodologyVersion: string,
): Finding {
  const r = e.reading
  const via = r.implementation
    ? ` It is a ${
        r.proxyKind === 'eip1167'
          ? 'EIP-1167 minimal proxy'
          : r.proxyKind === 'eip1967-beacon'
            ? `beacon proxy (beacon ${r.beacon})`
            : 'EIP-1967 proxy'
      } resolving to implementation ${r.implementation}, and the selector test was run against that implementation's bytecode, not the stub's.`
    : ''
  /**
   * Signed on purpose, as in the SHARE_COUNT class. A reverse split (multiplier below 1) made this
   * print "understated by -900.0000%" at severity low; the magnitude and the direction are now
   * separate, and severity reads the magnitude.
   */
  const pct = Math.abs(e.misreadPct)
  const direction = e.misreadPct >= 0 ? 'understates' : 'overstates'
  const delta = Math.abs(e.sharesUnaccounted)
  return {
    id: `integrator-${r.address.slice(2, 10)}-${e.symbol}`,
    defectClass: 'INTEGRATOR_NOT_MULTIPLIER_AWARE',
    severity: pct >= 10 ? 'high' : pct >= 1 ? 'medium' : 'low',
    subject: `${r.address} (holds ${e.symbol})`,
    affectedParty:
      `Whoever relies on this contract's accounting for ${e.symbol} — its depositors, its ` +
      `integrators, or anything reading a share count out of it.`,
    title: `${r.address.slice(0, 10)}… holds ${e.tokenUnits.toFixed(4)} ${e.symbol} and cannot call uiMultiplier() directly`,
    /**
     * Only the share count is at risk. This used to say that a VALUATION derived from the balance is
     * understated, which contradicts the project's own rule: balance x Chainlink feed price is
     * correct, because the feed is already multiplier-adjusted. What goes wrong is presenting the
     * balance as a share count, or pricing it with a per-SHARE price.
     */
    statement:
      `At block ${e.blockNumber} this contract holds ${e.tokenUnits.toFixed(6)} ${e.symbol}, and ` +
      `${e.symbol} uiMultiplier() returns ${e.uiMultiplier} (${e.multiplier.toFixed(9)}) at the same block; ` +
      `both reads are cited below. Its deployed bytecode does not push the ${UI_MULTIPLIER_SELECTOR} ` +
      `selector, so it cannot call uiMultiplier() directly.${via} Under ERC-8056 the share-equivalent ` +
      `count is balance x uiMultiplier() / 1e18 = ${e.shareEquivalents.toFixed(6)}, which is ` +
      `${delta.toFixed(6)} ${e.sharesUnaccounted >= 0 ? 'more' : 'fewer'} than the raw balance. IF this ` +
      `contract presents that balance as a share count, or prices it with a per-SHARE price, it ` +
      `${direction} the position by ${pct.toFixed(4)}%. Valuing the balance at the Chainlink feed price ` +
      `is correct and unaffected, because the feed is already multiplier-adjusted. IT MAY DO NEITHER — ` +
      `a contract that only custodies or routes the token never needs the multiplier and is not wrong ` +
      `to lack it. What is established here is the absence of the call, not the presence of a mistake.`,
    impact: {
      percent: Number(pct.toFixed(4)),
      measures: `how far the raw balance ${direction} the share-equivalent count, as a share of that count`,
      note:
        `${delta.toFixed(6)} share-equivalents of ${e.symbol} misread if this balance is read as a share count` +
        (e.usdHeld !== null
          ? `, against $${e.usdHeld.toLocaleString(undefined, { maximumFractionDigits: 0 })} held (balance x feed price)`
          : ', no usable price feed, so no dollar figure') +
        `. The token contract is behaving exactly as ERC-8056 specifies; this finding is about the reader.`,
    },
    evidence: integratorEvidence(r, blockNumber, observedAt, e),
    methodologyVersion,
    detectedAt: observedAt,
  }
}
