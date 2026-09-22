import { toFunctionSelector } from 'viem'
import { findingsPayload } from './src/lib/surface.js'
console.log('uiMultiplier() selector =', toFunctionSelector('function uiMultiplier() view returns (uint256)'))
const p: any = findingsPayload({ symbol: 'P' })
console.log('assay_findings(symbol="P") ->', p.count, 'row(s):')
for (const f of p.findings) console.log('   ', f.id, '|', f.subject, '|', f.severity, '|', f.title.slice(0,90))
