import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COUNT_HOLD_MAX_MS,
  privateSnapshotPath,
  publicBoard,
  shouldRefuse,
  sweepStatusPath,
  type CandidateBoard,
} from '../src/sweep/guard.js'

/**
 * The sweep's publish guard and what it publishes.
 *
 * The numbers are the production sweep log's, not invented: every refusal it recorded, and the
 * weekend arithmetic that would have latched the board at the Monday reopen. Runs fully offline;
 * the script test replaces the sweep itself with a fixture.
 */

const SHARE = 'SHARE_COUNT_MISREAD_RISK'
const CROSS = 'CROSS_SURFACE_PRICE_MIX'
const STALE = 'ORACLE_STALE_MARKET_CLOSED'
const NAMED = 'INTEGRATOR_NOT_MULTIPLIER_AWARE'

const rows = (defectClass: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${defectClass}-${i}`, defectClass }))

const T0 = '2026-09-28T00:08:00.000Z'
const minutesBefore = (iso: string, m: number) => new Date(Date.parse(iso) - m * 60_000).toISOString()

function candidate(o: {
  share?: number
  cross?: number
  named?: number
  stale?: number
  errors?: number
  assets?: number
  cohortRead?: number
  observedAt?: string
}): CandidateBoard {
  const read = o.cohortRead ?? 35
  return {
    observedAt: o.observedAt ?? T0,
    assetsScanned: o.assets ?? 195,
    findings: [
      ...rows(SHARE, o.share ?? 0),
      ...rows(CROSS, o.cross ?? 0),
      ...rows(NAMED, o.named ?? 0),
      ...rows(STALE, o.stale ?? 0),
    ],
    errors: Array.from({ length: o.errors ?? 0 }, (_, i) => ({ symbol: `S${i}`, error: 'HTTP 403' })),
    cohort: { size: 35, read, quorum: read / 35 >= 0.8 },
  }
}
const previous = (o: Parameters<typeof candidate>[0], ageMinutes = 8) =>
  candidate({ ...o, observedAt: minutesBefore(o.observedAt ?? T0, ageMinutes) })

describe('shouldRefuse — publishes a healthy run whatever it found', () => {
  it('publishes the Monday reopen: 116 with 35 stale feeds -> 81, zero errors', () => {
    // The latch: all 35 weekend stale-feed findings clear within 31 seconds of the reopen, a 30%
    // drop against a baseline that a refusal never moves.
    const sunday = previous({ share: 34, cross: 11, named: 36, stale: 35 })
    expect(sunday.findings).toHaveLength(116)
    const monday = candidate({ share: 34, cross: 11, named: 36 })
    expect(monday.findings).toHaveLength(81)
    expect(shouldRefuse(sunday, monday).refuse).toBe(false)
  })

  it('publishes the clean 63 -> 48 run the old guard refused', () => {
    // Logged: published now 48 / before 63 / sweep errors 0 / cohort read 35/35. The drop was
    // the integrator class, which follows who traded in the last few thousand blocks.
    const prev = previous({ share: 34, cross: 11, named: 18 })
    const next = candidate({ share: 34, cross: 11, named: 3 })
    const d = shouldRefuse(prev, next)
    expect(d.refuse).toBe(false)
    expect(d.reason).toMatch(/^healthy/)
  })

  it('publishes when there is no previous board', () => {
    expect(shouldRefuse(null, candidate({ share: 34 })).refuse).toBe(false)
  })

  it('does not treat an empty cohort as a read failure', () => {
    const next = { ...candidate({ share: 34 }), cohort: { size: 0, read: 0, quorum: false } }
    expect(shouldRefuse(previous({ share: 34 }), next).refuse).toBe(false)
  })
})

describe('shouldRefuse — refuses a run that failed to read the chain', () => {
  // Every refusal in the production log that was a real failure: [published now, before,
  // sweep errors, cohort read].
  const LOGGED: Array<[number, number, number, number]> = [
    [1, 71, 185, 35],
    [0, 77, 195, 20],
    [34, 75, 169, 20],
    [29, 68, 181, 20],
    [31, 78, 170, 20],
  ]
  for (const [now, before, errors, cohortRead] of LOGGED) {
    it(`refuses the logged ${now}/${before} run with ${errors}/195 errors, cohort ${cohortRead}/35`, () => {
      const prev = previous({ share: 34, cross: 11, named: before - 45 })
      const next = candidate({ share: Math.min(now, 34), cross: Math.max(0, now - 34), errors, cohortRead })
      const d = shouldRefuse(prev, next)
      expect(d.refuse).toBe(true)
      expect(d.reason).toContain(`${errors} of 195 assets could not be read`)
    })
  }

  it('refuses above 10% of assets unread, and not at it', () => {
    const prev = previous({ share: 34, cross: 11 })
    expect(shouldRefuse(prev, candidate({ share: 34, cross: 11, errors: 19 })).refuse).toBe(false)
    expect(shouldRefuse(prev, candidate({ share: 34, cross: 11, errors: 20 })).refuse).toBe(true)
  })

  it('refuses when the cohort quorum was not met, even with no asset errors', () => {
    const d = shouldRefuse(previous({ share: 34 }), candidate({ share: 34, cohortRead: 20 }))
    expect(d.refuse).toBe(true)
    expect(d.reason).toContain('cohort quorum not met: 20 of 35')
  })

  it('refuses an empty board over a non-empty one', () => {
    const d = shouldRefuse(previous({ share: 34, cross: 11 }), candidate({}))
    expect(d.refuse).toBe(true)
    expect(d.reason).toContain('no findings')
  })

  it('refuses a fall in the stable class, which a failed re-verification causes with zero errors', () => {
    const d = shouldRefuse(previous({ share: 34, cross: 11 }), candidate({ share: 20, cross: 11 }))
    expect(d.refuse).toBe(true)
    expect(d.reason).toContain('fell from 34 to 20')
  })

  it('refuses a scoped --publish of one asset over the full board', () => {
    const d = shouldRefuse(previous({ share: 34, cross: 11 }), candidate({ share: 1, assets: 1 }))
    expect(d.refuse).toBe(true)
  })

  it('never counts the market-driven or trader-driven classes', () => {
    const prev = previous({ share: 34, cross: 11, named: 43, stale: 35 })
    expect(shouldRefuse(prev, candidate({ share: 34 })).refuse).toBe(false)
  })
})

describe('shouldRefuse — the count check cannot latch', () => {
  it('stops holding the previous board once it is past the hold', () => {
    const holdMinutes = COUNT_HOLD_MAX_MS / 60_000
    const next = candidate({ share: 20, cross: 11 })
    expect(shouldRefuse(previous({ share: 34 }, holdMinutes), next).refuse).toBe(true)
    const d = shouldRefuse(previous({ share: 34 }, holdMinutes + 1), next)
    expect(d.refuse).toBe(false)
    expect(d.reason).toContain('past the 45-minute hold')
  })

  it('does not hold a board whose age cannot be read', () => {
    const prev = { findings: rows(SHARE, 34) }
    expect(shouldRefuse(prev, candidate({ share: 20 })).refuse).toBe(false)
  })

  it('never releases a read-health refusal, however old the board', () => {
    const d = shouldRefuse(previous({ share: 34 }, 24 * 60), candidate({ share: 34, errors: 195 }))
    expect(d.refuse).toBe(true)
  })

  it('never lets a narrower scope replace the full board, however old the board', () => {
    const holdMinutes = COUNT_HOLD_MAX_MS / 60_000
    const prev = previous({ share: 34, cross: 11 }, holdMinutes + 1)
    // `--symbols=CRWD --publish` once the board is past the hold: the count check has let go.
    const one = shouldRefuse(prev, candidate({ share: 1, assets: 1 }))
    expect(one.refuse).toBe(true)
    expect(one.reason).toContain('covered 1 assets where the previous board covered 195')
    // `--limit=100 --publish`, or a registry that returned half the assets.
    expect(shouldRefuse(prev, candidate({ share: 34, assets: 100 })).refuse).toBe(true)
    expect(shouldRefuse(previous({ share: 34 }, 24 * 60), candidate({ share: 34, assets: 100 })).refuse).toBe(true)
    // A registry that moved by a listing or two is still a full run.
    expect(shouldRefuse(prev, candidate({ share: 34, assets: 193 })).refuse).toBe(false)
  })
})

describe('publicBoard — named integrators never leave the host', () => {
  const snap = () => ({
    blockNumber: '1',
    findings: [
      { id: 'a', defectClass: SHARE },
      { id: 'integrator-0a0a0a0a-XYZ', defectClass: NAMED, subject: `0x${'0a'.repeat(20)} (holds XYZ)` },
      { id: 'b', defectClass: CROSS },
    ],
    rejected: [
      { finding: { id: 'r1', defectClass: NAMED, subject: `0x${'0b'.repeat(20)} (holds XYZ)` }, reason: 'unchecked' },
      { finding: { id: 'r2', defectClass: SHARE }, reason: 'unchecked' },
    ],
    integrators: { notAware: 25 },
  })

  it('strips the class from findings AND rejected, and says how many', () => {
    const b = publicBoard(snap())
    expect(b.findings.map((f) => f.id)).toEqual(['a', 'b'])
    expect(b.rejected.map((r) => r.finding.id)).toEqual(['r2'])
    expect(b.withheld).toEqual({ namedIntegrators: 1, namedIntegratorsRejected: 1 })
    expect(JSON.stringify(b)).not.toContain(NAMED)
    expect(JSON.stringify(b)).not.toContain('0a0a0a0a')
  })

  it('keeps every other field, in order, and appends the count', () => {
    const b = publicBoard(snap())
    expect(Object.keys(b)).toEqual(['blockNumber', 'findings', 'rejected', 'integrators', 'withheld'])
    expect(b.integrators).toEqual({ notAware: 25 })
  })

  it('is idempotent, so re-redacting a published board keeps its count', () => {
    const once = publicBoard(snap())
    expect(publicBoard(once)).toEqual(once)
  })

  it('does not modify the snapshot it was given', () => {
    const s = snap()
    publicBoard(s)
    expect(s.findings).toHaveLength(3)
    expect(s.rejected).toHaveLength(2)
  })
})

describe('where the sweep writes', () => {
  it('puts the status beside the board, wherever the board lives', () => {
    expect(sweepStatusPath('/home/ubuntu/assay-data/findings.json')).toBe('/home/ubuntu/assay-data/sweep-status.json')
    expect(sweepStatusPath('data/findings.json')).toBe(join('data', 'sweep-status.json'))
  })
  it('puts the unredacted snapshot beside the board, never on it', () => {
    expect(privateSnapshotPath('data/findings.json')).toBe('data/findings.private.json')
    expect(privateSnapshotPath('data/findings.scoped.json')).toBe('data/findings.scoped.private.json')
    expect(privateSnapshotPath('/srv/board')).toBe('/srv/board.private.json')
  })
})

// ---- scripts/sweep.ts end to end, with the sweep replaced by a fixture ----

const sweepMock = vi.hoisted(() => ({ result: null as unknown, throws: null as Error | null }))

vi.mock('../src/sweep/detect.js', () => ({
  sweep: async () => {
    if (sweepMock.throws) throw sweepMock.throws
    return structuredClone(sweepMock.result)
  },
}))

const finding = (id: string, defectClass: string) => ({
  id,
  defectClass,
  severity: 'medium',
  subject: defectClass === NAMED ? `0x${'ab'.repeat(20)} (holds XYZ)` : `${id} (0x${'11'.repeat(20)})`,
  title: id,
  verification: { checked: 1, reproduced: 1 },
})

function sweepResult(o: { share?: number; named?: number; namedRejected?: number; errors?: number; assets?: number }) {
  return {
    blockNumber: '70000000',
    observedAt: T0,
    marketClosed: false,
    cohort: { size: 35, read: 35, failed: 0, stale: 0, quorum: true, clockHint: false, marketClosed: false, blockNumber: '70000000' },
    chainNotes: [],
    assetsScanned: o.assets ?? 195,
    feedsAvailable: 35,
    findings: [
      ...Array.from({ length: o.share ?? 34 }, (_, i) => finding(`S${i}-share`, SHARE)),
      ...Array.from({ length: o.named ?? 0 }, (_, i) => finding(`integrator-${i}`, NAMED)),
    ],
    rejected: Array.from({ length: o.namedRejected ?? 0 }, (_, i) => ({
      finding: finding(`integrator-r${i}`, NAMED),
      reason: 'unchecked',
      detail: 'RPC failed',
    })),
    stats: { divergentMultipliers: 34, staleFeeds: 0, staleUnexpected: 0, staleIndeterminate: 0, missingFeeds: 160, pausedOracles: 0 },
    errors: Array.from({ length: o.errors ?? 0 }, (_, i) => ({ symbol: `S${i}`, error: 'HTTP 403' })),
    integrators: { scanned: 96, contracts: 66, notAware: o.named ?? 0, aware: 0, proxyUnresolved: 0, usdHeldByNotAware: 1, sharesUnaccounted: 1 },
  }
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

describe('scripts/sweep.ts', () => {
  let dir: string
  let out: string
  const argv = process.argv
  const envPath = process.env.ASSAY_FINDINGS_PATH

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assay-guard-'))
    out = join(dir, 'findings.json')
    sweepMock.throws = null
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exit(code ?? 0)
    }) as never)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.argv = argv
    if (envPath === undefined) delete process.env.ASSAY_FINDINGS_PATH
    else process.env.ASSAY_FINDINGS_PATH = envPath
    rmSync(dir, { recursive: true, force: true })
  })

  /** Run the script as the timer would. Resolves to its exit code. */
  async function run(...args: string[]): Promise<number> {
    vi.resetModules()
    process.env.ASSAY_FINDINGS_PATH = out
    process.argv = ['node', 'scripts/sweep.ts', ...args]
    try {
      await import('../scripts/sweep.js')
      return 0
    } catch (err) {
      if (err instanceof Exit) return err.code
      throw err
    }
  }
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
  const status = () => read(join(dir, 'sweep-status.json'))

  it('publishes the redacted board, the full snapshot privately, and a status', async () => {
    sweepMock.result = sweepResult({ share: 34, named: 25, namedRejected: 2 })
    expect(await run()).toBe(0)

    const board = read(out)
    expect(board.findings).toHaveLength(34)
    expect(board.rejected).toHaveLength(0)
    expect(board.withheld).toEqual({ namedIntegrators: 25, namedIntegratorsRejected: 2 })
    expect(readFileSync(out, 'utf8')).not.toContain(NAMED)

    const full = read(join(dir, 'findings.private.json'))
    expect(full.findings).toHaveLength(59)
    expect(full.rejected).toHaveLength(2)

    expect(status()).toMatchObject({
      outcome: 'published',
      published: 34,
      errors: 0,
      assetsScanned: 195,
      block: '70000000',
    })
    expect(Date.parse(status().lastRunAt)).not.toBeNaN()
  })

  it('publishes the Monday board over the weekend one', async () => {
    writeFileSync(
      out,
      JSON.stringify({ observedAt: minutesBefore(T0, 8), findings: [...rows(SHARE, 34), ...rows(CROSS, 11), ...rows(STALE, 35)] }),
    )
    sweepMock.result = sweepResult({ share: 34 })
    expect(await run()).toBe(0)
    expect(read(out).findings).toHaveLength(34)
    expect(status().outcome).toBe('published')
  })

  it('refuses a degraded run, leaves the board byte-for-byte, and records why', async () => {
    const before = JSON.stringify({ observedAt: minutesBefore(T0, 8), findings: rows(SHARE, 34) })
    writeFileSync(out, before)
    sweepMock.result = sweepResult({ share: 1, errors: 185 })
    expect(await run()).toBe(2)
    expect(readFileSync(out, 'utf8')).toBe(before)
    expect(existsSync(join(dir, 'findings.private.json'))).toBe(false)
    expect(status()).toMatchObject({ outcome: 'refused', published: 1, errors: 185, block: '70000000' })
    expect(status().reason).toContain('185 of 195 assets could not be read')
  })

  it('publishes a degraded run under --force, and says it was forced', async () => {
    writeFileSync(out, JSON.stringify({ observedAt: minutesBefore(T0, 8), findings: rows(SHARE, 34) }))
    sweepMock.result = sweepResult({ share: 1, errors: 185 })
    expect(await run('--force')).toBe(0)
    expect(read(out).findings).toHaveLength(1)
    expect(status()).toMatchObject({ outcome: 'published', reason: expect.stringContaining('forced') })
  })

  it('writes a scoped run to its own redacted file and leaves the board and its status alone', async () => {
    const before = JSON.stringify({ observedAt: minutesBefore(T0, 8), findings: rows(SHARE, 34) })
    writeFileSync(out, before)
    sweepMock.result = sweepResult({ share: 1, named: 3, assets: 1 })
    expect(await run('--symbols=CRWD')).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(before)
    const scoped = read(join(dir, 'findings.scoped.json'))
    expect(scoped.findings).toHaveLength(1)
    expect(scoped.withheld.namedIntegrators).toBe(3)
    expect(read(join(dir, 'findings.scoped.private.json')).findings).toHaveLength(4)
    expect(existsSync(join(dir, 'sweep-status.json'))).toBe(false)
  })

  it('refuses a scoped --publish over the full board', async () => {
    writeFileSync(out, JSON.stringify({ observedAt: minutesBefore(T0, 8), findings: rows(SHARE, 34) }))
    sweepMock.result = sweepResult({ share: 1, assets: 1 })
    expect(await run('--symbols=CRWD', '--publish')).toBe(2)
    expect(status().outcome).toBe('refused')
  })

  it('records a sweep that failed outright', async () => {
    sweepMock.throws = new Error('rh/assets: timed out after 5000ms')
    await expect(run()).rejects.toThrow('timed out')
    expect(status()).toMatchObject({ outcome: 'refused', block: null, published: 0 })
    expect(status().reason).toContain('rh/assets: timed out')
    expect(existsSync(out)).toBe(false)
  })
})
