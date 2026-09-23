import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The README's integrator rows, from both board shapes.
 *
 * Printed from the committed board, the row read "25 of 66 contracts ... holding $2,123,777": the
 * counts were (contract, token) pairs over 17 contracts, and about 99.6% of the dollars sat in AMM
 * pools, the v4 PoolManager and an executor, which never need the multiplier and are never named.
 * Runs the real --print path in an empty directory; nothing reaches the network.
 */

const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx')
const script = join(process.cwd(), 'scripts', 'readme-stats.ts')

const base = {
  blockNumber: '70000000',
  observedAt: '2026-09-26T13:00:00.000Z',
  assetsScanned: 195,
  feedsAvailable: 35,
  marketClosed: true,
  cohort: { size: 35, read: 35, stale: 1, failed: 0, quorum: true },
  findings: [{ defectClass: 'SHARE_COUNT_MISREAD_RISK', severity: 'critical', verification: { checked: 2, reproduced: 2 } }],
  rejected: [],
  chainNotes: [],
  stats: { divergentMultipliers: 34, missingFeeds: 160 },
  withheld: { namedIntegrators: 3, namedIntegratorsRejected: 0 },
}

function print(board: object): string {
  const cwd = mkdtempSync(join(tmpdir(), 'assay-readme-stats-'))
  try {
    mkdirSync(join(cwd, 'data'))
    writeFileSync(join(cwd, 'data', 'findings.json'), JSON.stringify(board))
    const r = spawnSync(tsx, [script, '--print'], { cwd, encoding: 'utf8', timeout: 30_000 })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    return r.stdout
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('readme-stats --print', () => {
  it('an old board gives holdings, not contracts, and no dollar headline', () => {
    const out = print({
      ...base,
      integrators: { scanned: 96, contracts: 66, notAware: 25, aware: 0, proxyUnresolved: 2, usdHeldByNotAware: 2123776.9, sharesUnaccounted: 1 },
    })
    expect(out).toContain('**25 of 66** (contract, token) holdings')
    expect(out).toMatch(/AMM pools and custody that never need the multiplier are inside that count/)
    expect(out).not.toMatch(/2,123,777/)
    expect(out).not.toMatch(/\d+ of \d+\*\* contracts/)
  }, 40_000)

  it('a new board puts NOT_AWARE and pools/custody on separate rows, with floors when unpriced', () => {
    const out = print({
      ...base,
      integrators: {
        scanned: 96,
        contracts: 17,
        notAware: 6,
        aware: 0,
        proxyUnresolved: 0,
        notApplicable: 11,
        tooSmall: 0,
        noHolding: 0,
        usdHeldByNotAware: 8_500,
        usdHeldByNotApplicable: 2_115_000,
        unpricedNotAware: 2,
        unpricedNotApplicable: 0,
        byRole: {
          AMM_POOL: { contracts: 7, usdHeld: 2_000_000 },
          AMM_POOL_MANAGER: { contracts: 1, usdHeld: 100_000 },
          CUSTODY: { contracts: 1, usdHeld: 15_000 },
          DISTRIBUTOR: { contracts: 2, usdHeld: 0 },
        },
        sharesUnaccounted: 1,
      },
    })
    const rows = out.split('\n').filter((l) => l.startsWith('| '))
    const notAware = rows.find((l) => l.includes('do not reference'))!
    const pools = rows.find((l) => l.startsWith('| Pools and custody'))!
    expect(notAware).toContain('**6** distinct contracts holding **at least $8,500**')
    expect(notAware).not.toMatch(/2,115,000/)
    expect(pools).toContain('**11** contracts (7 AMM pools, 1 pool manager, 1 custody or executor wallet, 2 distributors)')
    expect(pools).toContain('**$2,115,000**')
    // Scheduled closure with 1 of 35 stale: the clock called it, the cohort did not corroborate it.
    expect(out).toMatch(/\*\*the market was closed\*\* per the published 24\/5 schedule/)
    expect(out).not.toMatch(/corroborated/)
  }, 40_000)
})
