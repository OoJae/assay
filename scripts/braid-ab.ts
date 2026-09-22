import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { sweep } from '../src/sweep/detect.js'
import { adjudicate } from '../src/adjudicate/serv.js'
import { METHODOLOGY_VERSION } from '../src/adjudicate/methodology.js'

/**
 * The BRAID A/B, as a reproducible artifact.
 *
 * Identical model, identical evidence, identical prompt. The ONLY difference is the
 * `x-openserv-disable-braid: true` header. No trick payload and no misbehaving base model —
 * the case is simply one where the honest answer is to refuse.
 *
 * The mandate below states that positions are DISPLAYED in shares but never states that they
 * are COMPUTED from balanceOf(). The methodology requires WITHHELD when the mandate does not
 * establish that the subject performs the affected operation. Publishing a critical finding
 * against a named third party on an unestablished operation is the failure this guards against.
 */
const dev = process.argv.includes('--dev')

const MANDATE = `# Capital allocation agent

Watches a position and decides whether capital should hold, move to a stablecoin, or move into a
tokenized stock on Robinhood Chain. For each candidate it computes on-chain price, a Chainlink
reference price read on-chain, premium/discount, and underlying stock momentum from an off-chain
equities data source. Positions and P&L are displayed to the user in shares.`

console.error('sweeping CRWD at head…')
const r = await sweep({ symbols: ['CRWD'] })
const finding = r.findings.find((f) => f.defectClass === 'SHARE_COUNT_MISREAD_RISK')
if (!finding) {
  console.error('no SHARE_COUNT_MISREAD_RISK finding for CRWD — cannot run the A/B')
  process.exit(1)
}
console.error(
  `finding ${finding.id}: ${finding.verification.reproduced}/${finding.verification.checked} citations verified at block ${r.blockNumber}\n`,
)

async function run(disableBraid: boolean) {
  const t0 = Date.now()
  const a = await adjudicate(finding!, MANDATE, { dev, disableBraid })
  return { ...a, latencyMs: Date.now() - t0 }
}

console.error('adjudicating with BRAID ON…')
const on = await run(false)
console.error('adjudicating with BRAID OFF…')
const off = await run(true)

const artifact = {
  generatedAt: new Date().toISOString(),
  methodologyVersion: METHODOLOGY_VERSION,
  model: on.meta.model,
  block: r.blockNumber,
  finding: {
    id: finding.id,
    defectClass: finding.defectClass,
    deterministicSeverity: finding.severity,
    citations: `${finding.verification.reproduced}/${finding.verification.checked} reproduced byte-for-byte`,
    evidence: finding.evidence.map((e) => ({ claim: e.claim, call: e.call, rawReturn: e.rawReturn })),
  },
  mandate: MANDATE,
  braidOn: { verdict: on.verdict, severity: on.severity, rationale: on.rationale, withheld_reason: on.withheld_reason, latencyMs: on.latencyMs },
  braidOff: { verdict: off.verdict, severity: off.severity, rationale: off.rationale, withheld_reason: off.withheld_reason, latencyMs: off.latencyMs },
  interpretation:
    'The mandate states positions are displayed in shares but never states they are computed from ' +
    'balanceOf(). The methodology requires WITHHELD when the mandate does not establish that the ' +
    'subject performs the affected operation.',
}

writeFileSync('data/braid-ab.json', JSON.stringify(artifact, null, 2))

console.log('\n' + '='.repeat(74))
console.log('BRAID A/B — same model, same evidence, same prompt. Only the header differs.')
console.log('='.repeat(74))
console.log(`\nmodel   ${on.meta.model}`)
console.log(`finding ${finding.id}  (${finding.verification.reproduced}/${finding.verification.checked} citations verified)`)
console.log(`\n${''.padEnd(12)}${'BRAID ON'.padEnd(30)}BRAID OFF`)
console.log(`${'verdict'.padEnd(12)}${on.verdict.padEnd(30)}${off.verdict}`)
console.log(`${'severity'.padEnd(12)}${on.severity.padEnd(30)}${off.severity}`)
console.log(`${'latency'.padEnd(12)}${(on.latencyMs + 'ms').padEnd(30)}${off.latencyMs}ms`)
console.log(`\nBRAID ON  — ${on.rationale}`)
console.log(`\nBRAID OFF — ${off.rationale}`)
console.log(`\nsaved to data/braid-ab.json`)
