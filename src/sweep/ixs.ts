import { IXS_MCP_URL, IXS_VAULTS_URL } from '../lib/sources.js'

/**
 * IXS RWA vault surface.
 *
 * Verified live 2026-09-20:
 *  - GET https://api-v2.ixs.finance/vaults  -> public, no auth, 4 mainnet vaults
 *  - POST https://api-v2.ixs.finance/mcp    -> JSON-RPC 2.0 over Streamable HTTP, NO AUTH.
 *    Tools: vaults_list, vault_get, vault_check_whitelist,
 *           vault_build_request_deposit, vault_build_request_redeem
 *    Every tool returns UNSIGNED CALLDATA ONLY — nothing is signed server-side.
 *
 * THE #1 FOOTGUN: USDC on BNB Smart Chain (56) has 18 DECIMALS. On Avalanche (43114) it has 6.
 * Hardcoding parseUnits(amount, 6) against the BSC vault silently sends a dust amount.
 */

export interface IxsVault {
  id: string
  name: string
  symbol?: string
  chainId?: number
  chain?: { id?: number; name?: string }
  contractAddress?: `0x${string}`
  address?: `0x${string}`
  requiresWhitelist?: boolean
  status?: string
  actions?: string[]
  underlyingAsset?: { address?: `0x${string}`; decimals?: number; symbol?: string }
  network?: string
  chainName?: string
  explorerUrl?: string
  subgraphUrl?: string
  protocolVersion?: string
}

export function vaultChainId(v: IxsVault): number | undefined {
  return v.chainId ?? v.chain?.id
}
export function vaultAddress(v: IxsVault): `0x${string}` | undefined {
  return v.contractAddress ?? v.address
}

/** Canonical USDC decimals per chain — the value a naive integration gets wrong. */
export const USDC_DECIMALS: Record<number, number> = {
  56: 18, // Binance-Peg USDC 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d
  43114: 6, // Avalanche USDC 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E
}

export async function fetchIxsVaults(): Promise<IxsVault[]> {
  const res = await fetch(IXS_VAULTS_URL, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`ixs/vaults: HTTP ${res.status}`)
  const raw = (await res.json()) as unknown
  const r = raw as Record<string, unknown>
  const list = Array.isArray(raw)
    ? raw
    : ((r.items as unknown[]) ?? (r.data as unknown[]) ?? (r.vaults as unknown[]) ?? [])
  return list as IxsVault[]
}

let mcpId = 0

/**
 * Call an IXS MCP tool. The server speaks JSON-RPC 2.0 and replies as an SSE
 * `event: message` frame, so we parse the `data:` line out rather than assuming JSON.
 */
export async function ixsMcpCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const body = params
    ? { jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: { name: method, arguments: params } }
    : { jsonrpc: '2.0', id: ++mcpId, method }

  const res = await fetch(IXS_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`ixs/mcp ${method}: HTTP ${res.status}`)
  const text = await res.text()

  const dataLine = text
    .split('\n')
    .find((l) => l.startsWith('data:'))
  const payload = dataLine ? dataLine.slice(5).trim() : text
  const parsed = JSON.parse(payload) as { result?: T; error?: { message: string } }
  if (parsed.error) throw new Error(`ixs/mcp ${method}: ${parsed.error.message}`)
  return parsed.result as T
}

export async function listIxsTools(): Promise<Array<{ name: string; description?: string }>> {
  const r = await ixsMcpCall<{ tools: Array<{ name: string; description?: string }> }>('tools/list')
  return r.tools
}

/**
 * The naive-mode exhibit: what a 6-decimal assumption actually sends to an 18-decimal vault.
 * This is a pure calculation — no transaction is built or signed.
 */
export function decimalScaleError(humanAmount: string, assumedDecimals: number, actualDecimals: number) {
  const scale = (d: number) => BigInt(Math.round(Number(humanAmount) * 10 ** Math.min(d, 15))) * 10n ** BigInt(Math.max(0, d - 15))
  const sent = scale(assumedDecimals)
  const intended = scale(actualDecimals)
  const actualHuman = Number(sent) / 10 ** actualDecimals
  return {
    humanAmount,
    assumedDecimals,
    actualDecimals,
    rawSent: sent.toString(),
    rawIntended: intended.toString(),
    actuallyTransfers: actualHuman,
    shortfallFactor: actualDecimals > assumedDecimals ? 10 ** (actualDecimals - assumedDecimals) : 1,
  }
}
