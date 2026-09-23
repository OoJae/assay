import { readFileSync, writeFileSync } from 'node:fs'
import { redactSnapshot } from '../src/lib/redact.js'
import { COHORT_CLOSURE_FRACTION } from '../src/lib/sources.js'

/**
 * Regenerate the README's headline numbers from the published artifact.
 *
 * These were hardcoded and dated "2026-09-20", so they drifted from the wall the moment the next
 * sweep landed — a project whose thesis is that published numbers must be checkable, publishing
 * numbers that no longer matched its own data file. Run after every sweep:
 *
 *     pnpm sweep && pnpm readme:stats
 *
 * `--print` writes the block to stdout and leaves README.md alone.
 */
interface Snapshot {
  blockNumber: string
  observedAt: string
  assetsScanned: number
  feedsAvailable: number
  marketClosed: boolean
  cohort: { size: number; read: number; stale: number; failed: number; quorum: boolean }
  findings: Array<{ defectClass: string; severity: string; verification: { checked: number; reproduced: number } }>
  rejected: Array<{ finding: { defectClass: string } }>
  chainNotes: unknown[]
  stats: Record<string, number>
  integrators?: {
    scanned: number
    contracts: number
    notAware: number
    usdHeldByNotAware: number
    aware?: number
    proxyUnresolved?: number
    // Present only on boards swept after distinct counting (see src/sweep/detect.ts).
    notApplicable?: number
    tooSmall?: number
    noHolding?: number
    usdHeldByNotApplicable?: number
    unpricedNotAware?: number
    unpricedNotApplicable?: number
    byRole?: Record<string, { contracts: number; usdHeld: number }>
  }
  withheld?: { namedIntegrators?: number; namedIntegratorsRejected?: number }
}

/**
 * Counted from the PUBLIC board only.
 *
 * These counted the unredacted artifact, so the README said 70 findings with 115/115 citations
 * while the wall, which withholds named integrators, said 45 with 90/90. The 25-finding gap was
 * exactly the withheld class, so the README both contradicted the wall and pointed at what it
 * hid. The file is redacted at the source now; redacting again here costs nothing and keeps a
 * hand-run against an old unredacted file from reintroducing the gap.
 */
const raw = JSON.parse(readFileSync('data/findings.json', 'utf8')) as Snapshot
const d = redactSnapshot(raw)
const withheldNamed =
  (raw.withheld?.namedIntegrators ?? 0) + raw.findings.length - d.findings.length
const checked = d.findings.reduce((n, f) => n + f.verification.checked, 0)
const reproduced = d.findings.reduce((n, f) => n + f.verification.reproduced, 0)
const divergent = d.stats.divergentMultipliers ?? 0
const missing = d.stats.missingFeeds ?? 0
const stale = d.cohort.stale
const date = d.observedAt.slice(0, 10)

const marketLine = !d.cohort.quorum
  ? `**indeterminate** — only ${d.cohort.read} of ${d.cohort.size} feeds could be read, below the 80% quorum this methodology requires before concluding anything`
  : d.marketClosed
    ? d.cohort.read > 0 && stale / d.cohort.read >= COHORT_CLOSURE_FRACTION
      ? `**${stale} of the ${d.cohort.read} feeds read were stale, and the market was closed** — corroborated by the cohort going stale together`
      : // The clock decides first now (src/lib/sources.ts), so a closure can be called before the
        // cohort has gone stale. Claiming the cohort corroborated it would be false.
        `**the market was closed** per the published 24/5 schedule (Friday 20:00 to Sunday 20:00 New York time); ${stale} of the ${d.cohort.read} feeds read had passed their heartbeat so far`
    : `**${stale} of the ${d.cohort.read} feeds read were stale, with the market open** — a stale feed during market hours is an incident, not a schedule`

/**
 * Integrators on their own lines, as aggregates.
 *
 * They are not in the findings count below because no contract is named on a public surface; the
 * lines say how many were measured and how many named findings that left out.
 *
 * Two board shapes, told apart by `notApplicable` as the wall does (web/lib/present.ts). This row
 * used to print "25 of 66 contracts ... holding $2,123,777" from a board whose counts are (contract,
 * token) PAIRS over 17 contracts, and about 99.6% of that dollar figure sat in AMM pools, the v4
 * PoolManager and an executor: contracts that move tokens and never need a share count. So an old
 * board gets no dollar headline, and a new one puts pools and custody on a line of their own. Neither
 * says "N of M contracts cannot", which implies the rest can: pools, too-small contracts and
 * unresolved proxies cannot call it either.
 */
const usd = (n: number, unpriced = 0) =>
  `${unpriced > 0 ? 'at least ' : ''}$${Math.round(n).toLocaleString('en-US')}`
const ROLE_LABEL: Record<string, [one: string, many: string]> = {
  AMM_POOL: ['AMM pool', 'AMM pools'],
  AMM_POOL_MANAGER: ['pool manager', 'pool managers'],
  CUSTODY: ['custody or executor wallet', 'custody or executor wallets'],
  DISTRIBUTOR: ['distributor', 'distributors'],
}
const ig = d.integrators
const unnamed = `none is named here or on the wall, so their ${withheldNamed} findings are not in the count below`
let integratorLine = ''
if (ig && typeof ig.notApplicable !== 'number') {
  integratorLine =
    `| Holder contracts with no \`uiMultiplier()\` reference | **${ig.notAware} of ${ig.contracts}** (contract, token) ` +
    `holdings among ${ig.scanned} recent counterparties, on a board from before distinct counting: AMM pools and ` +
    `custody that never need the multiplier are inside that count, so no dollar figure is drawn from it; ` +
    `${unnamed} |\n`
} else if (ig) {
  const roles = Object.entries(ig.byRole ?? {})
    .filter(([, r]) => r.contracts > 0)
    .map(([role, r]) => `${r.contracts} ${ROLE_LABEL[role]?.[r.contracts === 1 ? 0 : 1] ?? role}`)
  const others = [
    `${ig.aware ?? 0} reference it`,
    `${ig.notApplicable} are pools or custody`,
    `${ig.tooSmall ?? 0} are too small to hold valuation logic`,
    `${ig.proxyUnresolved ?? 0} are proxies that could not be resolved`,
    `${ig.noHolding ?? 0} held none at the block`,
  ].join(', ')
  integratorLine =
    `| Holder contracts that hold divergent-multiplier tokens and do not reference \`uiMultiplier()\` | ` +
    `**${ig.notAware}** distinct contracts holding **${usd(ig.usdHeldByNotAware, ig.unpricedNotAware)}**, ` +
    `found among ${ig.scanned} recent counterparties (${ig.contracts} with code: ${others}) — an aggregate only: ` +
    `${unnamed} |\n` +
    `| Pools and custody holding them (never need a share count) | **${ig.notApplicable}** contracts` +
    `${roles.length ? ` (${roles.join(', ')})` : ''} holding ` +
    `**${usd(ig.usdHeldByNotApplicable ?? 0, ig.unpricedNotApplicable)}**, reported apart from the row above and never named |\n`
}

const block = `<!-- ASSAY:STATS -->
Measured live on mainnet (chain 4663) at block \`${d.blockNumber}\`, ${date}. **These numbers are
generated from [\`data/findings.json\`](data/findings.json) by \`pnpm readme:stats\`, not typed in** —
they were hardcoded once and drifted away from the artifact they described.

| | count |
|---|---|
| Stock Tokens with \`uiMultiplier() != 1.0\` | **${divergent} of ${d.assetsScanned}** |
| Assets with **no Chainlink feed at all** | **${missing} of ${d.assetsScanned}** (a chain note, not a finding — an absence cannot be proven by an \`eth_call\`) |
| 24/5 equity feeds past their heartbeat | ${marketLine} |
${integratorLine}| Findings published | **${d.findings.length}**, with **${reproduced}/${checked}** citations re-fetched and byte-compared |
| Findings rejected by the verifier | **${(d.rejected ?? []).length}** — rendered on the wall with the reason, because a verification claim is only worth something if the misses are visible |
<!-- /ASSAY:STATS -->`

if (process.argv.includes('--print')) {
  console.log(block)
  process.exit(0)
}

const readme = readFileSync('README.md', 'utf8')
const re = /<!-- ASSAY:STATS -->[\s\S]*?<!-- \/ASSAY:STATS -->/
if (!re.test(readme)) {
  console.error('README.md has no <!-- ASSAY:STATS --> block — nothing to regenerate')
  process.exit(1)
}
writeFileSync('README.md', readme.replace(re, block))
console.log(`README stats regenerated from block ${d.blockNumber} (${date})`)
console.log(
  `  ${d.findings.length} findings · ${reproduced}/${checked} citations · ${(d.rejected ?? []).length} rejected · ` +
    `${withheldNamed} named-integrator findings withheld`,
)
