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
      defectClass: 'SHARE_COUNT_MISREAD_RISK',
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
  it('treats one stale feed among fresh peers on a weekday as an incident', () => {
    expect(scheduledClosure(1, 35, false)).toBe(false)
  })
  it('treats one stale feed inside the weekend closure as the closure starting', () => {
    // The cohort goes stale one feed at a time through Saturday; see test/sources.test.ts.
    expect(scheduledClosure(1, 35, true)).toBe(true)
  })
  it('lets the clock decide inside the closure whatever the fraction', () => {
    expect(scheduledClosure(18, 35, true)).toBe(true)
    expect(scheduledClosure(18, 35, false)).toBe(false)
  })
  it('follows the clock for a tiny cohort', () => {
    expect(scheduledClosure(1, 2, true)).toBe(true)
  })
})

describe('rejection reasons are never conflated', () => {
  it('an RPC failure is reported as unchecked, not as fabrication', async () => {
    const head = await rhClient.getBlockNumber()
    const f: Finding = {
      id: 'rpc-fail',
      defectClass: 'NO_PRICE_FEED',
      severity: 'medium',
      subject: 'X (0x0000000000000000000000000000000000000001)',
      title: 'citation whose call cannot be re-executed',
      statement: 'the finding may be perfectly true; we simply could not confirm it',
      impact: { note: 'n/a' },
      evidence: [
        {
          claim: 'someUnknownGetter() == 1e18',
          chainId: 4663,
          contract: CRWD,
          // A signature the verifier has no ABI for. This is a genuine 'error' status: we cannot
          // check the claim at all. Note that pointing at a non-contract address would NOT work
          // here — that returns 0x, which is a real mismatch and should stay classified as one.
          call: 'someUnknownGetter()',
          rawReturn: '0x' + (10n ** 18n).toString(16).padStart(64, '0'),
          blockNumber: head.toString(),
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
      // The bug this guards: reporting "fabrication" when the truth is "we could not check".
      expect(r.rejected.reason).toBe('unchecked')
      expect(r.rejected.reason).not.toBe('mismatch')
      expect(r.rejected.detail).toContain('unchecked, not disproven')
    }
  }, 30_000)
})
