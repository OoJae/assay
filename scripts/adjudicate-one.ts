import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { verifyFindingDetailed, type VerifiedFinding } from '../src/verify/index.js'
import { adjudicate, AdjudicatorError } from '../src/adjudicate/serv.js'
import { sweep } from '../src/sweep/detect.js'
import { isNamedIntegrator } from '../src/lib/redact.js'
import type { Finding } from '../src/sweep/types.js'

/**
 * Adjudicate ONE finding, by id, against a generic mandate. A development tool; it spends a SERV call.
 *
 *   tsx scripts/adjudicate-one.ts [--id=CRWD-share-count] [--dev] [--no-braid]
 *
 * The id is looked up in the committed data/findings.json, but its citations cannot be re-checked
 * there: the public RPC serves state for 5,000-10,000 blocks and the snapshot is far older, so
 * verification always failed and this exited "failed verification" — while debug-serv.ts, which
 * shares the lookup, dereferenced the null and crashed. A pruned citation now triggers a fresh
 * sweep of that one symbol, and the same finding id is taken from it, verified at a live block.
 */
export async function loadFindingForAdjudication(
  id: string,
  path = 'data/findings.json',
): Promise<{ ok: true; finding: VerifiedFinding; source: string } | { ok: false; reason: string }> {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { findings: Finding[] }
  const committed = data.findings.find((f) => f.id === id)
  if (!committed) {
    return { ok: false, reason: `no finding with id=${id}. available: ${data.findings.slice(0, 20).map((f) => f.id).join(', ')}` }
  }
  if (isNamedIntegrator(committed)) return { ok: false, reason: `${id} names a third-party contract and is not adjudicated` }

  const checked = await verifyFindingDetailed(committed)
  if (checked.ok) return { ok: true, finding: checked.finding, source: `${path}, re-verified` }
  if (checked.rejected.reason === 'mismatch') {
    return { ok: false, reason: `${id} failed verification (${checked.rejected.detail}) — not publishable, not adjudicated` }
  }

  const symbol = id.split('-')[0]!
  const r = await sweep({ symbols: [symbol], integrators: false })
  const fresh = r.findings.find((f) => f.id === id)
  if (!fresh) {
    return {
      ok: false,
      reason: `${id} is unverifiable here (${checked.rejected.detail}) and a fresh sweep of ${symbol} at block ${r.blockNumber} did not reproduce it`,
    }
  }
  return { ok: true, finding: fresh, source: `fresh sweep at block ${r.blockNumber} (the committed copy is past RPC retention)` }
}

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

async function main() {
  const args = process.argv.slice(2)
  const id = args.find((a) => a.startsWith('--id='))?.split('=')[1] ?? 'CRWD-share-count'
  const dev = args.includes('--dev')
  const noBraid = args.includes('--no-braid')

  const loaded = await loadFindingForAdjudication(id)
  if (!loaded.ok) {
    console.error(loaded.reason)
    process.exit(1)
  }
  const verified = loaded.finding
  console.error(`verified ${verified.verification.reproduced}/${verified.verification.checked} citations (${loaded.source})\n`)

  const t0 = Date.now()
  try {
    const result = await adjudicate(verified, MANDATE, { dev, disableBraid: noBraid })
    const ms = Date.now() - t0
    console.log(JSON.stringify({ id, braid: !noBraid, model: result.meta.model, latencyMs: ms, verdict: result.verdict, severity: result.severity, rationale: result.rationale, binding_evidence: result.binding_evidence, withheld_reason: result.withheld_reason, finishReason: result.meta.finishReason }, null, 2))
  } catch (e) {
    if (!(e instanceof AdjudicatorError)) throw e
    console.error(e.message)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
