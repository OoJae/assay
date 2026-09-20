import { listIxsTools, fetchIxsVaults, vaultChainId, vaultAddress, USDC_DECIMALS, decimalScaleError } from '../src/sweep/ixs.js'

const tools = await listIxsTools()
console.log('IXS MCP tools:', tools.map((t) => t.name).join(', '))

const vaults = await fetchIxsVaults()
console.log('\nvaults:')
for (const v of vaults) {
  const c = vaultChainId(v)
  console.log(`  chain ${c}  wl=${v.requiresWhitelist}  usdcDecimals=${c ? USDC_DECIMALS[c] : '?'}  ${vaultAddress(v)}`)
}

console.log('\nnaive 6-decimal assumption against the 18-decimal BSC vault, depositing 10 USDC:')
console.log(decimalScaleError('10', 6, 18))
