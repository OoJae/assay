import type { Verdict } from './serv.js'

/**
 * HARD ADJUDICATION SET.
 *
 * The first A/B came back 100%/100% because the fixture was easy: verified evidence, and a
 * mandate that plainly failed gate 3. That measures nothing about a reasoning layer.
 *
 * BRAID's claimed domain is branching instructions — "decision trees, policy matrices, and
 * instructions where different conditions lead to different outcomes". Multipath exists for
 * exactly that. So a fair test needs mandates where the gates genuinely contend: explicit
 * operations with PARTIAL handling, handling documented for the WRONG surface, exclusions that
 * moot the defect, thresholds that are documented but numerically insufficient, and scope that
 * is adjacent rather than absent.
 *
 * Ground truth below is derived strictly from the v2 ordered gates, not from intuition. Each
 * case names the gate that decides it so the label can be argued with.
 */
export interface HardCase {
  id: string
  /** Which sweep finding this mandate is adjudicated against. */
  findingClass: 'SHARE_COUNT_MISREPORT' | 'ORACLE_STALE_MARKET_CLOSED'
  mandate: string
  expected: Verdict
  /** The gate that decides it, and why — so a reviewer can challenge the label. */
  rationale: string
}

const SHARE = 'SHARE_COUNT_MISREPORT' as const
const STALE = 'ORACLE_STALE_MARKET_CLOSED' as const

export const HARD_CASES: HardCase[] = [
  {
    id: 'explicit-op-no-handling',
    findingClass: SHARE,
    mandate: `# Portfolio agent
We display each holding's share count to the user. The displayed share count is computed as
balanceOf(holder) / 1e18. Positions are rebalanced weekly against those share counts.`,
    expected: 'MATERIAL_MISSTATEMENT',
    rationale:
      'Gate 3 passes: the mandate explicitly states the share count is computed from balanceOf(). ' +
      'Gate 4 fires MATERIAL_MISSTATEMENT because no conversion via uiMultiplier is documented.',
  },
  {
    id: 'explicit-op-correct-handling',
    findingClass: SHARE,
    mandate: `# Portfolio agent
We display each holding's share count to the user. The displayed share count is computed as
balanceOf(holder) * uiMultiplier() / 1e36, so corporate actions are reflected.`,
    expected: 'BENIGN',
    rationale:
      'Gate 3 passes, then gate 4 fires BENIGN: correct handling via uiMultiplier is documented.',
  },
  {
    id: 'handling-on-wrong-surface',
    findingClass: SHARE,
    mandate: `# Portfolio agent
The holdings table converts via uiMultiplier() before rendering share counts. Realised and
unrealised P&L are computed separately, directly from balanceOf(), and are shown to the user
in shares.`,
    expected: 'MATERIAL_MISSTATEMENT',
    rationale:
      'Gate 3 passes for the P&L surface, which explicitly uses balanceOf(). Gate 4 fires ' +
      'MATERIAL_MISSTATEMENT: handling is documented for the holdings table but NOT for P&L, ' +
      'which is the surface the defect corrupts. Partial handling elsewhere is not a defence.',
  },
  {
    id: 'explicit-exclusion-moots-defect',
    findingClass: SHARE,
    mandate: `# Portfolio agent
We display holdings in shares using balanceOf(). Any asset whose uiMultiplier() is not exactly
1e18 is excluded from the product entirely and never shown or traded.`,
    expected: 'BENIGN',
    rationale:
      'Gate 3 passes, then gate 4 fires BENIGN: the documented exclusion means the defect cannot ' +
      'reach a user-facing number. An exclusion IS correct handling.',
  },
  {
    id: 'adjacent-scope-only',
    findingClass: SHARE,
    mandate: `# Bridge relayer
We move USDG between Robinhood Chain and Ethereum. We quote bridge fees in USDG and never read,
display, value or hold tokenized equities.`,
    expected: 'BENIGN',
    rationale:
      'Gate 2 fires BENIGN: the mandate describes no activity in the affected area at all.',
  },
  {
    id: 'red-herring-handling',
    findingClass: SHARE,
    mandate: `# Treasury agent
We value tokenized equity positions and report their USD value to our treasury committee. We are
careful with token decimals, normalising 6-decimal and 18-decimal stablecoins correctly across
chains before any comparison.`,
    expected: 'CONTROL_WEAKNESS',
    rationale:
      'Gate 2 passes (it values equity positions). Gate 3 fires CONTROL_WEAKNESS: decimals handling ' +
      'is documented but that is a DIFFERENT defect class, and the mandate never states that share ' +
      'counts are computed from balanceOf(). Documented care elsewhere does not establish the operation.',
  },
  {
    id: 'threshold-documented-but-insufficient',
    findingClass: STALE,
    mandate: `# Lending market keeper
We price tokenized equity collateral from the on-chain Chainlink feed before every liquidation.
We check feed freshness and reject any price whose updatedAt is more than 7 days old.`,
    expected: 'MATERIAL_MISSTATEMENT',
    rationale:
      'Gate 3 passes: the mandate explicitly states it reads the feed and checks freshness. Gate 4 ' +
      'fires MATERIAL_MISSTATEMENT because the documented 7-day threshold is numerically weaker than ' +
      "the feed's own 86400s heartbeat, so a 50-hour-stale price passes their check and prices a " +
      'liquidation. Documented-but-insufficient handling is not correct handling.',
  },
  {
    id: 'stale-feed-no-freshness-check',
    findingClass: STALE,
    mandate: `# Lending market keeper
We price tokenized equity collateral from the on-chain Chainlink feed before every liquidation
using latestRoundData().`,
    expected: 'MATERIAL_MISSTATEMENT',
    rationale:
      'Gate 3 passes: reading latestRoundData() for liquidation pricing is stated explicitly. ' +
      'Gate 4 fires MATERIAL_MISSTATEMENT: no staleness guard is documented at all.',
  },
]
