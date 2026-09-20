import { describe, it, expect } from 'vitest'
import { verifyFindingDetailed } from '../src/verify/index.js'
import { sweep } from '../src/sweep/detect.js'
import { scheduledClosure } from '../src/lib/sources.js'
import type { Finding } from '../src/sweep/types.js'
import { rhClient } from '../src/lib/chains.js'

const CRWD = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931' as const

describe('retention bug regression', () => {
  it('a pruned citation is rejected as unverifiable_here, NOT as fabrication', async () => {
    const head = await rhClient.getBlockNumber()
    const ancient = head - 5_000_000n
    const f: Finding = {
      id: 'ancient',
      defectClass: 'SHARE_COUNT_MISREPORT',
      severity: 'critical',
      subject: `CRWD (${CRWD})`,
      title: 'cited at a pruned block',
      statement: 'true, but no longer checkable on this RPC',
      impact: { note: 'n/a' },
      evidence: [
        {
          claim: 'uiMultiplier() == 4e18',
          chainId: 4663,
          contract: CRWD,
          call: 'uiMultiplier()',
          rawReturn: '0x' + (4n * 10n ** 18n).toString(16).padStart(64, '0'),
          blockNumber: ancient.toString(),
          explorerUrl: '',
          observedAt: new Date().toISOString(),
        },
      ],
      methodologyVersion: 'test',
      detectedAt: new Date().toISOString(),
    }
    const r = await verifyFindingDetailed(f)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // This is the bug: it used to be indistinguishable from fabrication.
      expect(r.rejected.reason).toBe('unverifiable_here')
      expect(r.rejected.detail).toContain('no longer serves')
    }
  }, 30_000)

  it('a live sweep loses nothing to pruning', async () => {
    const r = await sweep({ symbols: ['CRWD', 'NVDA', 'SPY', 'ASML'] })
    expect(r.findings.length).toBeGreaterThan(0)
    const unverifiable = r.rejected.filter((x) => x.reason === 'unverifiable_here')
    expect(unverifiable).toHaveLength(0)
    // every published citation reproduced byte-for-byte
    for (const f of r.findings) {
      expect(f.verification.reproduced).toBe(f.verification.checked)
      expect(f.verification.pruned).toBe(0)
    }
  }, 180_000)
})

describe('scheduled-closure corroboration', () => {
  it('treats a whole-cohort outage as a scheduled closure', () => {
    expect(scheduledClosure(35, 35, false)).toBe(true)
  })
  it('treats one stale feed among fresh peers as an incident', () => {
    expect(scheduledClosure(1, 35, true)).toBe(false)
  })
  it('defers to the clock when the signal is ambiguous', () => {
    expect(scheduledClosure(18, 35, true)).toBe(true)
    expect(scheduledClosure(18, 35, false)).toBe(false)
  })
  it('falls back to the clock for a tiny cohort', () => {
    expect(scheduledClosure(1, 2, true)).toBe(true)
  })
})
