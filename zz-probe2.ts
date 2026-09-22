import { rhClient } from './src/lib/chains.js'
import { fetchRhAssets } from './src/lib/sources.js'
import { encodeFunctionData } from 'viem'
const abi = [
  { name: 'effectiveAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'newUIMultiplier', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'uiMultiplier', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const
const assets = await fetchRhAssets()
const bn = await rhClient.getBlockNumber()
let bad = 0, zero = 0, pending = 0, total = 0, regEff = 0
for (const a of assets) {
  const dep = a.deployments?.find((d: any) => d.chainId === 4663) ?? a.deployments?.[0]
  if (!dep) continue
  total++
  if (a.pendingMultiplierEffectiveTime) regEff++
  try {
    const call = async (fn: any) => {
      const r: any = await rhClient.request({ method: 'eth_call', params: [{ to: dep.contractAddress, data: encodeFunctionData({ abi, functionName: fn }) }, `0x${bn.toString(16)}`] } as never)
      return r === '0x' ? null : BigInt(r)
    }
    const e = await call('effectiveAt'); const n = await call('newUIMultiplier'); const u = await call('uiMultiplier')
    if (e === null) { bad++; console.log('EMPTY effectiveAt:', a.tokenSymbol) }
    else if (e === 0n) zero++
    if (n !== null && u !== null && n !== u) { pending++; console.log('PENDING:', a.tokenSymbol, 'new', n, 'cur', u, 'eff', e, 'regEff', a.pendingMultiplierEffectiveTime) }
  } catch (err: any) { bad++; console.log('ERR', a.tokenSymbol, String(err.message).slice(0,60)) }
}
console.log({ total, emptyOrErr: bad, effZero: zero, pendingOnChain: pending, registryEffPresent: regEff })
