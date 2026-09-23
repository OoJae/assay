/**
 * The free wallet check: raw balance next to share-equivalents, read from the visitor's browser.
 *
 * It calls the deployed ERC8056Guard rather than computing balance x multiplier here, so what the
 * page shows is exactly what an integrator gets by making the same call, refusal included. Nothing
 * passes through ASSAY's servers and nothing is paid. Browser-safe: no node imports.
 */
import { createPublicClient, formatUnits, getAddress, http, isAddress, parseAbi } from 'viem'
import { GUARD_ADDRESS, RH_RPC_URL } from './guard'

export const GUARD_ABI = parseAbi([
  'function shareEquivalents(address token, address holder) view returns (uint256 shares, bool safe, string reason)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
])

/** Every read the check makes, so a test can stand in for the chain. */
export interface GuardReader {
  blockNumber(): Promise<bigint>
  balanceOf(token: `0x${string}`, holder: `0x${string}`, blockNumber: bigint): Promise<bigint>
  shareEquivalents(
    token: `0x${string}`,
    holder: `0x${string}`,
    blockNumber: bigint,
  ): Promise<readonly [bigint, boolean, string]>
  decimals(token: `0x${string}`, blockNumber: bigint): Promise<number>
}

export interface HeldRow {
  symbol: string
  token: `0x${string}`
  balance: bigint
  /** null when decimals() could not be read; the raw integers are still shown. */
  decimals: number | null
  /** The guard's figure, in the token's base units. null when the guard call itself failed. */
  shares: bigint | null
  safe: boolean | null
  /** The guard's refusal reason, or why the guard could not be read. */
  reason: string | null
}

export interface WalletCheck {
  holder: `0x${string}`
  blockNumber: bigint
  checked: number
  held: HeldRow[]
  /** Tokens read as a zero balance. */
  zero: number
  /** Tokens whose balance could not be read. Not zero: unknown. */
  unread: string[]
}

export class WalletCheckError extends Error {
  constructor(
    readonly kind: 'bad_address' | 'rpc_unavailable',
    message: string,
  ) {
    super(message)
  }
}

/**
 * A 0x address, checksummed. Mixed case must pass EIP-55, the same rule the paid agent applies,
 * because a mistyped character in a checksummed address is exactly what EIP-55 exists to catch.
 */
export function parseHolder(input: string): `0x${string}` {
  let v = input.trim()
  if (/^0x[0-9A-F]{40}$/.test(v)) v = v.toLowerCase()
  if (!isAddress(v)) {
    throw new WalletCheckError(
      'bad_address',
      /^0x[0-9a-fA-F]{40}$/.test(v)
        ? 'That address fails its EIP-55 checksum. Check for a mistyped character, or paste it in lowercase.'
        : 'Enter a 0x address: 0x followed by 40 hex characters.',
    )
  }
  return getAddress(v)
}

const RPC_DOWN =
  'The public Robinhood Chain RPC did not answer from your browser. It sometimes serves a ' +
  'Cloudflare challenge instead of JSON for a few minutes; try again shortly, or run the cast ' +
  'command below from a terminal.'

/**
 * Read every divergent token at ONE block: balances first, then the guard and decimals() only for
 * what is held, so a typical wallet costs one round of ~34 reads instead of three.
 *
 * A failed balance read is reported as unread, never as zero. If every read failed the RPC is
 * down, and saying "this address holds nothing" would be the unread-counted-as-clean error this
 * project exists to catch.
 */
export async function checkWallet(
  holderInput: string,
  tokens: Array<{ symbol: string; token: `0x${string}` }>,
  reader: GuardReader,
): Promise<WalletCheck> {
  const holder = parseHolder(holderInput)
  let blockNumber: bigint
  try {
    blockNumber = await reader.blockNumber()
  } catch {
    throw new WalletCheckError('rpc_unavailable', RPC_DOWN)
  }

  const balances = await Promise.allSettled(tokens.map((t) => reader.balanceOf(t.token, holder, blockNumber)))
  const unread = tokens.filter((_, i) => balances[i]!.status === 'rejected').map((t) => t.symbol)
  if (tokens.length > 0 && unread.length === tokens.length) throw new WalletCheckError('rpc_unavailable', RPC_DOWN)

  const heldTokens = tokens.flatMap((t, i) => {
    const b = balances[i]!
    return b.status === 'fulfilled' && b.value > 0n ? [{ ...t, balance: b.value }] : []
  })
  const held = await Promise.all(
    heldTokens.map(async (t): Promise<HeldRow> => {
      const [g, d] = await Promise.allSettled([
        reader.shareEquivalents(t.token, holder, blockNumber),
        reader.decimals(t.token, blockNumber),
      ])
      const decimals = d.status === 'fulfilled' ? d.value : null
      if (g.status === 'rejected') {
        return { ...t, decimals, shares: null, safe: null, reason: 'the guard call could not be read' }
      }
      const [shares, safe, reason] = g.value
      return { ...t, decimals, shares: safe ? shares : null, safe, reason: safe ? null : reason || 'refused' }
    }),
  )
  return {
    holder,
    blockNumber,
    checked: tokens.length,
    held,
    zero: tokens.length - unread.length - held.length,
    unread,
  }
}

/**
 * The live reader. Batches of 25: the RPC answers HTTP 429 to a single JSON-RPC batch somewhere
 * between 51 and 100 calls (measured), and viem otherwise sends every read of a tick in one POST.
 *
 * Two retries: in a real browser one of the four POSTs of a check came back with
 * `Access-Control-Allow-Origin: *,*`, which the browser rejects as a CORS failure, and the retry
 * went through. curl never saw the doubled header, so it is intermittent on the RPC's side.
 */
export function viemGuardReader(rpcUrl: string = RH_RPC_URL): GuardReader {
  const client = createPublicClient({
    transport: http(rpcUrl, { batch: { batchSize: 25 }, retryCount: 2, timeout: 10_000 }),
  })
  return {
    blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    balanceOf: (token, holder, blockNumber) =>
      client.readContract({ address: token, abi: GUARD_ABI, functionName: 'balanceOf', args: [holder], blockNumber }),
    shareEquivalents: (token, holder, blockNumber) =>
      client.readContract({
        address: GUARD_ADDRESS,
        abi: GUARD_ABI,
        functionName: 'shareEquivalents',
        args: [token, holder],
        blockNumber,
      }),
    decimals: (token, blockNumber) =>
      client.readContract({ address: token, abi: GUARD_ABI, functionName: 'decimals', blockNumber }),
  }
}

/** A base-unit integer for reading: at most `maxFraction` decimals, truncated, never rounded up. */
export function fmtUnits(v: bigint, decimals: number, maxFraction = 6): string {
  const s = formatUnits(v, decimals)
  const [whole, frac = ''] = s.split('.')
  const cut = frac.slice(0, maxFraction).replace(/0+$/, '')
  if (v > 0n && whole === '0' && !cut) return `<0.${'0'.repeat(maxFraction - 1)}1`
  return cut ? `${whole}.${cut}` : whole!
}

/** A check as the page prints it: strings only, so the component never needs viem to render. */
export interface CheckView {
  holder: string
  blockNumber: string
  checked: number
  zero: number
  unread: string[]
  rows: Array<{
    symbol: string
    token: string
    balance: string
    shares: string | null
    safe: boolean | null
    reason: string | null
  }>
}

export function toView(r: WalletCheck): CheckView {
  const fmt = (v: bigint, d: number | null) => (d === null ? v.toString() : fmtUnits(v, d))
  return {
    holder: r.holder,
    blockNumber: r.blockNumber.toString(),
    checked: r.checked,
    zero: r.zero,
    unread: r.unread,
    rows: r.held.map((h) => ({
      symbol: h.symbol,
      token: h.token,
      balance: fmt(h.balance, h.decimals),
      shares: h.shares === null ? null : fmt(h.shares, h.decimals),
      safe: h.safe,
      reason: h.reason,
    })),
  }
}
