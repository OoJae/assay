import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { verifyFinding } from '../src/verify/index.js'
import { adjudicate } from '../src/adjudicate/serv.js'
import type { Finding } from '../src/sweep/types.js'

const args = process.argv.slice(2)
const id = args.find((a) => a.startsWith('--id='))?.split('=')[1] ?? 'CRWD-share-count'
const dev = args.includes('--dev')
const noBraid = args.includes('--no-braid')

const data = JSON.parse(readFileSync('data/findings.json', 'utf8')) as { findings: Finding[] }
const finding = data.findings.find((f) => f.id === id)
if (!finding) {
  console.error(`no finding with id=${id}. available: ${data.findings.slice(0, 20).map((f) => f.id).join(', ')}`)
  process.exit(1)
}

const verified = await verifyFinding(finding)
if (!verified) {
  console.error('finding failed verification — not publishable')
  process.exit(1)
}
console.error(`verified ${verified.verification.reproduced}/${verified.verification.checked} citations\n`)

// A representative declared mandate.
//
// Deliberately GENERIC. ASSAY grades named third parties, so its own test fixtures must not
// single out a real project — a fixture that quotes a competitor's README reads as targeting,
// which is exactly the posture the publication ethics rule out. The shape below is what matters:
// it states that positions are DISPLAYED in shares, and it never states that they are COMPUTED
// from balanceOf(). That gap is the whole point of the adjudication.
const MANDATE = `# Capital allocation agent

Watches a position and decides whether capital should hold, move to a stablecoin, or move into a
tokenized stock on Robinhood Chain. For each candidate it computes on-chain price, a Chainlink
reference price read on-chain, premium/discount, and underlying stock momentum from an off-chain
equities data source. Positions and P&L are displayed to the user in shares.`

const t0 = Date.now()
const result = await adjudicate(verified, MANDATE, { dev, disableBraid: noBraid })
const ms = Date.now() - t0

console.log(JSON.stringify({ id, braid: !noBraid, model: result.meta.model, latencyMs: ms, verdict: result.verdict, severity: result.severity, rationale: result.rationale, binding_evidence: result.binding_evidence, withheld_reason: result.withheld_reason }, null, 2))
