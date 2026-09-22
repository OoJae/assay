import { rhClient } from './src/lib/chains.js'
import { fetchRhAssets } from './src/lib/sources.js'
import { encodeFunctionData } from 'viem'
const abi = [
  { name: 'uiMultiplier', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'newUIMultiplier', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'effectiveAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const
const assets = await fetchRhAssets()
const bn = await rhClient.getBlockNumber()
let n = 0
for (const a of assets.slice(0, 200)) {
  const dep = a.deployments?.find((d: any) => d.chainId === 4663) ?? a.deployments?.[0]
  if (!dep) continue
  const out: string[] = []
  for (const fn of ['uiMultiplier', 'newUIMultiplier', 'effectiveAt'] as const) {
    try {
      const r: any = await rhClient.request({ method: 'eth_call', params: [{ to: dep.contractAddress, data: encodeFunctionData({ abi, functionName: fn }) }, `0x${bn.toString(16)}`] } as never)
      out.push(`${fn}=${r === '0x' ? 'EMPTY' : BigInt(r).toString()}`)
    } catch (e: any) { out.push(`${fn}=ERR:${String(e.message).slice(0, 40)}`) }
  }
  console.log(a.tokenSymbol, out.join(' '), '| registry pendingEff=', a.pendingMultiplierEffectiveTime ?? 'none', 'pendingMult=', a.pendingMultiplier)
  if (++n >= 8) break
}
