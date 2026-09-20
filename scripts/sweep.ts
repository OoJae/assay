import { sweep } from '../src/sweep/detect.js'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const limitArg = args.find((a) => a.startsWith('--limit='))
const symArg = args.find((a) => a.startsWith('--symbols='))

const result = await sweep({
  onProgress: (d, t, s) => { if (d % 20 === 0 || d === t) process.stderr.write(`  ...${d}/${t} (${s})\n`) },
  limit: limitArg ? Number(limitArg.split('=')[1]) : undefined,
  symbols: symArg ? symArg.split('=')[1]!.split(',') : undefined,
})

writeFileSync('data/findings.json', JSON.stringify(result, null, 2))

console.log(`\nASSAY sweep @ block ${result.blockNumber}  (${result.observedAt})`)
console.log(`assets scanned: ${result.assetsScanned}   robinhood feeds available: ${result.feedsAvailable}`)
console.log(`stats:`, result.stats)
const mismatch = result.rejected.filter((r) => r.reason === 'mismatch').length
const unverifiable = result.rejected.filter((r) => r.reason === 'unverifiable_here').length
console.log(`findings published: ${result.findings.length}`)
console.log(`rejected: ${result.rejected.length}  (mismatch/fabrication: ${mismatch}, unverifiable here: ${unverifiable})`)
console.log(`sweep errors: ${result.errors.length}`)
const totalCites = result.findings.reduce((n, f) => n + f.verification.checked, 0)
const okCites = result.findings.reduce((n, f) => n + f.verification.reproduced, 0)
console.log(`citations: ${okCites}/${totalCites} reproduced byte-for-byte at block ${result.blockNumber}\n`)

const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<string, number>
const byClass: Record<string, number> = {}
for (const f of result.findings) {
  bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  byClass[f.defectClass] = (byClass[f.defectClass] ?? 0) + 1
}
console.log('by severity:', bySeverity)
console.log('by class:', byClass)

if (result.chainNotes.length) {
  console.log('\nchain-level notes (verifiable, but no on-chain citation — reported separately):')
  for (const n of result.chainNotes) console.log(`  [${n.severity.toUpperCase()}] ${n.title}`)
}
console.log(`\nmarket: ${result.marketClosed ? 'CLOSED' : 'open'}  (cohort ${result.cohort.stale}/${result.cohort.size} stale, clockHint=${result.cohort.clockHint})`)

console.log('\ntop findings:')
const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>
for (const f of [...result.findings].sort((a, b) => order[a.severity]! - order[b.severity]!).slice(0, 12)) {
  console.log(`  [${f.severity.toUpperCase().padEnd(8)}] ${f.defectClass.padEnd(28)} ${f.title}`)
}
