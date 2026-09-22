import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Regenerate the README's headline numbers from the published artifact.
 *
 * These were hardcoded and dated "2026-09-20", so they drifted from the wall the moment the next
 * sweep landed — a project whose thesis is that published numbers must be checkable, publishing
 * numbers that no longer matched its own data file. Run after every sweep:
 *
 *     pnpm sweep && pnpm readme:stats
 */
interface Snapshot {
  blockNumber: string
  observedAt: string
  assetsScanned: number
  feedsAvailable: number
  marketClosed: boolean
  cohort: { size: number; read: number; stale: number; failed: number; quorum: boolean }
  findings: Array<{ defectClass: string; severity: string; verification: { checked: number; reproduced: number } }>
  rejected: unknown[]
  chainNotes: unknown[]
  stats: Record<string, number>
}

const d = JSON.parse(readFileSync('data/findings.json', 'utf8')) as Snapshot
const checked = d.findings.reduce((n, f) => n + f.verification.checked, 0)
const reproduced = d.findings.reduce((n, f) => n + f.verification.reproduced, 0)
const divergent = d.stats.divergentMultipliers ?? 0
const missing = d.stats.missingFeeds ?? 0
const stale = d.cohort.stale
const date = d.observedAt.slice(0, 10)

const marketLine = !d.cohort.quorum
  ? `**indeterminate** — only ${d.cohort.read} of ${d.cohort.size} feeds could be read, below the 80% quorum this methodology requires before concluding anything`
  : d.marketClosed
    ? `**${stale} of the ${d.cohort.read} feeds read were stale, and the market was closed** — inferred from cohort corroboration, not a calendar`
    : `**${stale} of the ${d.cohort.read} feeds read were stale, with the market open** — a stale feed during market hours is an incident, not a schedule`

const block = `<!-- ASSAY:STATS -->
Measured live on mainnet (chain 4663) at block \`${d.blockNumber}\`, ${date}. **These numbers are
generated from [\`data/findings.json\`](data/findings.json) by \`pnpm readme:stats\`, not typed in** —
they were hardcoded once and drifted away from the artifact they described.

| | count |
|---|---|
| Stock Tokens with \`uiMultiplier() != 1.0\` | **${divergent} of ${d.assetsScanned}** |
| Assets with **no Chainlink feed at all** | **${missing} of ${d.assetsScanned}** (a chain note, not a finding — an absence cannot be proven by an \`eth_call\`) |
| 24/5 equity feeds past their heartbeat | ${marketLine} |
| Findings published | **${d.findings.length}**, with **${reproduced}/${checked}** citations re-fetched and byte-compared |
| Findings withheld | **${d.rejected.length}** — rendered on the wall with the reason, because a verification claim is only worth something if the misses are visible |
<!-- /ASSAY:STATS -->`

const readme = readFileSync('README.md', 'utf8')
const re = /<!-- ASSAY:STATS -->[\s\S]*?<!-- \/ASSAY:STATS -->/
if (!re.test(readme)) {
  console.error('README.md has no <!-- ASSAY:STATS --> block — nothing to regenerate')
  process.exit(1)
}
writeFileSync('README.md', readme.replace(re, block))
console.log(`README stats regenerated from block ${d.blockNumber} (${date})`)
console.log(`  ${d.findings.length} findings · ${reproduced}/${checked} citations · ${d.rejected.length} withheld`)
