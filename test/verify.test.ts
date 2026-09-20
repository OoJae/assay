import { describe, it, expect } from 'vitest'
import { verifyEvidence, verifyFinding } from '../src/verify/index.js'
import type { Evidence, Finding } from '../src/sweep/types.js'
import { rhClient } from '../src/lib/chains.js'

const CRWD = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931' as const
const TRUE_MULTIPLIER = '0x' + (4n * 10n ** 18n).toString(16).padStart(64, '0')

async function head() {
  return await rhClient.getBlockNumber()
}

function ev(overrides: Partial<Evidence>, block: bigint): Evidence {
  return {
    claim: 'uiMultiplier() == 4e18',
    chainId: 4663,
    contract: CRWD,
    call: 'uiMultiplier()',
    rawReturn: TRUE_MULTIPLIER,
    blockNumber: block.toString(),
    explorerUrl: `https://robinhoodchain.blockscout.com/address/${CRWD}`,
    observedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('evidence verifier', () => {
  it('reproduces a true citation', async () => {
    const b = await head()
    const r = await verifyEvidence(ev({}, b))
    expect(r.reproduced).toBe(true)
  }, 30_000)

  it('REJECTS a falsified return value', async () => {
    const b = await head()
    const fake = '0x' + (9n * 10n ** 18n).toString(16).padStart(64, '0')
    const r = await verifyEvidence(ev({ rawReturn: fake }, b))
    expect(r.reproduced).toBe(false)
    expect(r.reason).toBe('raw return mismatch')
  }, 30_000)

  it('REJECTS a citation pointing at the wrong contract', async () => {
    const b = await head()
    const r = await verifyEvidence(
      ev({ contract: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' }, b), // NVDA, multiplier != 4e18
    )
    expect(r.reproduced).toBe(false)
  }, 30_000)

  it('REJECTS an unknown call signature rather than trusting it', async () => {
    const b = await head()
    const r = await verifyEvidence(ev({ call: 'totallyMadeUp()' }, b))
    expect(r.reproduced).toBe(false)
    expect(r.reason).toContain('unknown call signature')
  }, 30_000)

  it('drops a finding whose every citation fails', async () => {
    const b = await head()
    const bogus: Finding = {
      id: 'bogus',
      defectClass: 'SHARE_COUNT_MISREPORT',
      severity: 'critical',
      subject: 'fabricated',
      title: 'fabricated finding',
      statement: 'this should never be published',
      impact: { note: 'n/a' },
      evidence: [ev({ rawReturn: '0x' + '0'.repeat(64) }, b)],
      methodologyVersion: 'test',
      detectedAt: new Date().toISOString(),
    }
    expect(await verifyFinding(bogus)).toBeNull()
  }, 30_000)

  it('DISCREDITS the whole finding if ANY citation is fabricated', async () => {
    const b = await head()
    const mixed: Finding = {
      id: 'mixed',
      defectClass: 'SHARE_COUNT_MISREPORT',
      severity: 'critical',
      subject: `CRWD (${CRWD})`,
      title: 'one true, one false',
      statement: 'partial',
      impact: { note: 'n/a' },
      evidence: [ev({}, b), ev({ rawReturn: '0x' + '1'.repeat(64) }, b)],
      methodologyVersion: 'test',
      detectedAt: new Date().toISOString(),
    }
    // Policy: a single mismatched citation means the finding is not publishable at all.
    // Partial truth is not a defence when the subject is a named third party.
    expect(await verifyFinding(mixed)).toBeNull()
  }, 30_000)

  it('classifies a pruned block as unchecked, NOT as fabrication', async () => {
    const b = await head()
    const ancient = b - 5_000_000n
    const r = await verifyEvidence(ev({ blockNumber: ancient.toString() }, ancient))
    expect(r.reproduced).toBe(false)
    expect(r.status).toBe('pruned')
    expect(r.reason).toContain('not an archive node')
  }, 30_000)

  it('flags a genuine mismatch as mismatch, not pruned', async () => {
    const b = await head()
    const r = await verifyEvidence(ev({ rawReturn: '0x' + '7'.repeat(64) }, b))
    expect(r.status).toBe('mismatch')
  }, 30_000)
})
