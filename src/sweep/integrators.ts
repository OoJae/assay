import { keccak256, toFunctionSelector } from 'viem'
import { rhClient } from '../lib/chains.js'
import { stockTokenAbi } from '../lib/abis.js'
import { evidence } from './oracle.js'
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

export type IntegratorVerdict =
  /** Bytecode references uiMultiplier(). Not exposed. */
  | 'AWARE'
  /** Substantial bytecode, selector absent, not a proxy. The only verdict that gets published. */
  | 'NOT_AWARE'
  /** A proxy whose implementation could not be resolved. NO CLAIM IS MADE. */
  | 'PROXY_UNRESOLVED'
  /** No code at all — an externally owned account. */
  | 'EOA'
  /** Has code but too little to hold valuation logic. */
  | 'TOO_SMALL'

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
  /** Size of the bytecode the selector test actually ran against. */
  testedCodeSize?: number
  hasMultiplierSelector: boolean
  hasPausedSelector: boolean
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
const IMPLEMENTATION_SELECTOR = '0x5c60da1b'

const EIP1167_PREFIX = '363d3d373d3d3d363d73'
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3'

/** Pull the implementation out of an EIP-1167 minimal proxy's bytecode: it is inlined verbatim. */
function eip1167Implementation(code: string): `0x${string}` | null {
  const i = code.indexOf(EIP1167_PREFIX)
  if (i < 0 || !code.includes(EIP1167_SUFFIX)) return null
  const addr = code.slice(i + EIP1167_PREFIX.length, i + EIP1167_PREFIX.length + 40)
  return /^[0-9a-f]{40}$/i.test(addr) ? (`0x${addr}` as `0x${string}`) : null
}

async function getCode(address: `0x${string}`, blockNumber: bigint): Promise<string> {
  return (await rhClient.request({
    method: 'eth_getCode',
    params: [address, `0x${blockNumber.toString(16)}`],
  } as never)) as string
}

/**
 * Classify one address.
 *
 * PROXIES ARE RESOLVED OR WITHHELD, never guessed. A proxy's own bytecode is a delegatecall stub
 * that contains no application selectors at all, so a naive selector test would report every proxy
 * on the chain as NOT_AWARE — the single most likely way this module could libel someone.
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

  const has = (sel: string) => code.toLowerCase().includes(sel.slice(2).toLowerCase())

  // --- Proxy resolution, before any selector conclusion is drawn ---
  let implAddr = eip1167Implementation(code.toLowerCase())
  let proxyKind: IntegratorReading['proxyKind'] = implAddr ? 'eip1167' : undefined

  if (!implAddr) {
    try {
      const slot = (await rhClient.request({
        method: 'eth_getStorageAt',
        params: [address, EIP1967_IMPLEMENTATION_SLOT, `0x${blockNumber.toString(16)}`],
      } as never)) as string
      if (slot && /[1-9a-f]/i.test(slot.slice(26))) {
        implAddr = `0x${slot.slice(26)}` as `0x${string}`
        proxyKind = 'eip1967'
      }
    } catch {
      /* treated as unresolved below */
    }
  }

  let beacon: `0x${string}` | undefined
  if (!implAddr) {
    try {
      const slot = (await rhClient.request({
        method: 'eth_getStorageAt',
        params: [address, EIP1967_BEACON_SLOT, `0x${blockNumber.toString(16)}`],
      } as never)) as string
      if (slot && /[1-9a-f]/i.test(slot.slice(26))) {
        beacon = `0x${slot.slice(26)}` as `0x${string}`
        const res = (await rhClient.request({
          method: 'eth_call',
          params: [{ to: beacon, data: IMPLEMENTATION_SELECTOR }, `0x${blockNumber.toString(16)}`],
        } as never)) as string
        if (res && res.length >= 66 && /[1-9a-f]/i.test(res.slice(26, 66))) {
          implAddr = `0x${res.slice(26, 66)}` as `0x${string}`
          proxyKind = 'eip1967-beacon'
        } else {
          // Beacon present but unreadable: NO CLAIM.
          return { ...base, verdict: 'PROXY_UNRESOLVED', proxyKind: 'eip1967-beacon', beacon }
        }
      }
    } catch {
      if (beacon) return { ...base, verdict: 'PROXY_UNRESOLVED', proxyKind: 'eip1967-beacon', beacon }
    }
  }

  if (implAddr) {
    let implCode: string
    try {
      implCode = await getCode(implAddr, blockNumber)
    } catch {
      return { ...base, verdict: 'PROXY_UNRESOLVED', proxyKind, beacon }
    }
    const implSize = Math.max(0, (implCode.length - 2) / 2)
    if (implSize === 0)
      return { ...base, verdict: 'PROXY_UNRESOLVED', proxyKind, beacon, implementation: implAddr }

    const implHas = (sel: string) => implCode.toLowerCase().includes(sel.slice(2).toLowerCase())
    return {
      ...base,
      verdict: implHas(UI_MULTIPLIER_SELECTOR)
        ? 'AWARE'
        : implSize < MIN_LOGIC_BYTES
          ? 'TOO_SMALL'
          : 'NOT_AWARE',
      implementation: implAddr,
      implementationCodeHash: keccak256(implCode as `0x${string}`),
      proxyKind,
      beacon,
      testedCodeSize: implSize,
      hasMultiplierSelector: implHas(UI_MULTIPLIER_SELECTOR),
      hasPausedSelector: implHas(ORACLE_PAUSED_SELECTOR),
    }
  }

  // --- Not a proxy: the selector test is meaningful ---
  if (has(UI_MULTIPLIER_SELECTOR)) {
    return {
      ...base,
      verdict: 'AWARE',
      testedCodeSize: codeSize,
      hasMultiplierSelector: true,
      hasPausedSelector: has(ORACLE_PAUSED_SELECTOR),
    }
  }
  if (codeSize < MIN_LOGIC_BYTES) return { ...base, verdict: 'TOO_SMALL', testedCodeSize: codeSize }
  return {
    ...base,
    verdict: 'NOT_AWARE',
    testedCodeSize: codeSize,
    hasPausedSelector: has(ORACLE_PAUSED_SELECTOR),
  }
}

/** The citations a NOT_AWARE finding rests on. Both are re-runnable by the verifier. */
export function integratorEvidence(
  r: IntegratorReading,
  blockNumber: bigint,
  observedAt: string,
): Evidence[] {
  const target = r.implementation ?? r.address
  const hash = r.implementationCodeHash ?? r.codeHash
  const ev = [
    evidence(
      `keccak256(eth_getCode(${target})) == ${hash} — ${r.testedCodeSize ?? r.codeSize} bytes, no ${UI_MULTIPLIER_SELECTOR} selector`,
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
        `0x${'0'.repeat(24)}${r.implementation.slice(2)}`,
        blockNumber,
        observedAt,
      ),
    )
  }
  return ev
}

export interface IntegratorExposure {
  reading: IntegratorReading
  symbol: string
  token: `0x${string}`
  multiplier: number
  tokenUnits: number
  shareEquivalents: number
  sharesUnaccounted: number
  misreadPct: number
  usdHeld: number | null
}

/** balanceOf x uiMultiplier — the same arithmetic truePosition() sells, applied to a third party. */
export async function integratorExposure(
  reading: IntegratorReading,
  symbol: string,
  token: `0x${string}`,
  multiplier: number,
  tokenPriceUsd: number | null,
): Promise<IntegratorExposure | null> {
  let bal: bigint
  try {
    bal = (await rhClient.readContract({
      address: token,
      abi: stockTokenAbi,
      functionName: 'balanceOf',
      args: [reading.address],
    })) as bigint
  } catch {
    return null
  }
  const tokenUnits = Number(bal) / 1e18
  if (tokenUnits <= 0) return null
  const shareEquivalents = tokenUnits * multiplier
  return {
    reading,
    symbol,
    token,
    multiplier,
    tokenUnits,
    shareEquivalents,
    sharesUnaccounted: shareEquivalents - tokenUnits,
    misreadPct: multiplier > 0 ? (1 - 1 / multiplier) * 100 : 0,
    usdHeld: tokenPriceUsd !== null ? tokenUnits * tokenPriceUsd : null,
  }
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Every address that sent or received this token in the recent past.
 *
 * Log retention on this RPC is deeper than STATE retention, so this reaches further back than a
 * citation can. The window is bounded because the sweep has to finish inside the ~8 minute cadence
 * that keeps citations re-fetchable.
 */
export async function recentCounterparties(
  token: `0x${string}`,
  head: bigint,
  windows = 5,
  windowSize = 9_000n,
): Promise<Set<`0x${string}`>> {
  const out = new Set<`0x${string}`>()
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
    } catch {
      break // log retention exhausted; what we have is what we report
    }
  }
  return out
}

/** Build the published Finding. Only ever called for a NOT_AWARE reading. */
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
  return {
    id: `integrator-${r.address.slice(2, 10)}-${e.symbol}`,
    defectClass: 'INTEGRATOR_NOT_MULTIPLIER_AWARE',
    severity: e.misreadPct >= 10 ? 'high' : e.misreadPct >= 1 ? 'medium' : 'low',
    subject: `${r.address} (holds ${e.symbol})`,
    affectedParty:
      `Whoever relies on this contract's accounting for ${e.symbol} — its depositors, its ` +
      `integrators, or anything reading a share count or valuation out of it.`,
    title: `${r.address.slice(0, 10)}… holds ${e.tokenUnits.toFixed(4)} ${e.symbol} and cannot call uiMultiplier()`,
    statement:
      `This contract holds ${e.tokenUnits.toFixed(6)} ${e.symbol} (${e.symbol} uiMultiplier() = ` +
      `${e.multiplier.toFixed(9)}), and its deployed bytecode does not contain the ` +
      `${UI_MULTIPLIER_SELECTOR} selector, so it cannot call uiMultiplier() directly.${via} ` +
      `Under ERC-8056 the share-equivalent count is balance x uiMultiplier() / 1e18 = ` +
      `${e.shareEquivalents.toFixed(6)}, which is ${e.sharesUnaccounted.toFixed(6)} more than the ` +
      `raw balance. IF this contract derives a share count or a valuation from that balance, the ` +
      `figure is understated by ${e.misreadPct.toFixed(4)}%. IT MAY NOT DO SO — a contract that ` +
      `only custodies or routes the token never needs the multiplier and is not wrong to lack it. ` +
      `What is established here is the absence of the call, not the presence of a mistake.`,
    impact: {
      percent: Number(e.misreadPct.toFixed(4)),
      note:
        `${e.sharesUnaccounted.toFixed(6)} share-equivalents of ${e.symbol} unaccounted for if this ` +
        `balance is read as a share count` +
        (e.usdHeld !== null ? `, against $${e.usdHeld.toLocaleString(undefined, { maximumFractionDigits: 0 })} held` : '') +
        `. The token contract is behaving exactly as ERC-8056 specifies; this finding is about the reader.`,
    },
    evidence: integratorEvidence(r, blockNumber, observedAt),
    methodologyVersion,
    detectedAt: observedAt,
  }
}
