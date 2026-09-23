import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { selectStale, serialise, WINDOW_OPENS, WINDOW_CLOSES } from '../scripts/heldout-capture-stale.js'
import type { VerifiedFinding } from '../src/verify/index.js'

const f = (id: string, defectClass: string) => ({ id, defectClass }) as unknown as VerifiedFinding
const board = (observedAt: string, findings: VerifiedFinding[]) => ({ observedAt, blockNumber: 1, findings })

describe('the STALE capture applies the pre-registered rule and nothing else', () => {
  it('takes the first ORACLE_STALE_MARKET_CLOSED finding in board order', () => {
    const r = selectStale(board('2026-09-26T20:04:00Z', [
      f('NVDA-share-count', 'SHARE_COUNT_MISREAD_RISK'),
      f('AAPL-stale-feed', 'ORACLE_STALE_INDETERMINATE'),
      f('SPY-stale-feed', 'ORACLE_STALE_MARKET_CLOSED'),
      f('TSLA-stale-feed', 'ORACLE_STALE_MARKET_CLOSED'),
    ]))
    expect(r.ok && r.finding.id).toBe('SPY-stale-feed')
  })

  it('refuses a board observed before the window opens, and says to retry', () => {
    const r = selectStale(board('2026-09-26T19:59:59Z', [f('SPY-stale-feed', 'ORACLE_STALE_MARKET_CLOSED')]))
    expect(r).toMatchObject({ ok: false, retry: true })
  })

  it('after the window closes the cases are not run, and it says so rather than retrying', () => {
    const r = selectStale(board(WINDOW_CLOSES, [f('SPY-stale-feed', 'ORACLE_STALE_MARKET_CLOSED')]))
    expect(r).toMatchObject({ ok: false, retry: false })
    expect(!r.ok && r.reason).toMatch(/not run/)
  })

  it('a board in the window with no such finding is a retry, not a substitute class', () => {
    const r = selectStale(board(WINDOW_OPENS, [f('SPY-stale-feed', 'ORACLE_STALE_UNEXPECTED')]))
    expect(r).toMatchObject({ ok: false, retry: true })
  })

  it('re-serialising the committed fixtures file reproduces it byte for byte', () => {
    const raw = readFileSync('src/adjudicate/heldout/fixtures.json', 'utf8')
    expect(serialise(JSON.parse(raw))).toBe(raw)
  })
})
