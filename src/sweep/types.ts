export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type DefectClass =
  | 'CROSS_SURFACE_PRICE_MIX'
  /**
   * 24/5 equity feed past its heartbeat because the market is closed. EXPECTED by design —
   * the defect is the caller's missing guard, since latestRoundData() still returns a price
   * and gives no on-chain signal that it is closed.
   */
  | 'ORACLE_STALE_MARKET_CLOSED'
  /** Past heartbeat when it should NOT be: a crypto feed, or an equity feed during market hours. */
  | 'ORACLE_STALE_UNEXPECTED'
  /**
   * Past heartbeat, and we could not read enough of the 24/5 cohort to say whether that is a
   * scheduled closure or an incident. Deliberately its own class: silently picking either
   * answer would let our own RPC flakiness decide a subject's severity.
   */
  | 'ORACLE_STALE_INDETERMINATE'
  | 'NO_PRICE_FEED'
  /**
   * Renamed from SHARE_COUNT_MISREPORT. Nothing MISREPORTS anything here: a Stock Token that
   * moves uiMultiplier() is doing exactly what ERC-8056 specifies. The exposure is a RISK borne
   * by an integrator that reads balanceOf() as a share count. The old name screenshotted as
   * "ASSAY flags CRWD critical", which is an accusation against a compliant contract.
   */
  | 'SHARE_COUNT_MISREAD_RISK'
  | 'ORACLE_PAUSED'
  /** Robinhood's docs require an L2 sequencer-uptime check, but no such feed is published. */
  | 'SEQUENCER_FEED_UNAVAILABLE'
  | 'PENDING_CORPORATE_ACTION'
  | 'VAULT_DECIMAL_SCALE'
  | 'VAULT_WHITELIST'
  | 'VAULT_ASYNC_SETTLEMENT'

/**
 * A single verified observation. Every numeric field here must be reproducible by
 * re-running the cited call at the cited block — the verifier enforces this before
 * anything is published.
 */
export interface Evidence {
  /** Human-readable claim, e.g. "uiMultiplier() == 4e18" */
  claim: string
  chainId: number
  contract: `0x${string}`
  /** Solidity signature actually called, e.g. "uiMultiplier()" */
  call: string
  /** Raw hex returned by eth_call, byte-for-byte */
  rawReturn: string
  blockNumber: string
  explorerUrl: string
  observedAt: string
}

export interface Finding {
  id: string
  defectClass: DefectClass
  severity: Severity
  /**
   * WHAT WAS READ — the contract or feed whose state produced this finding.
   *
   * Naming it "subject" invited the reading that it is the accused. For most classes here it is
   * not: an ERC-8056 token that moves its multiplier is spec-compliant, and the party carrying
   * the exposure is whoever reads it wrongly. `affectedParty` says who that is, and the README's
   * own standard — that falsely accusing a subject which did it right is the most damaging error
   * this tool can make — is what forced the split.
   */
  subject: string
  /** WHO CARRIES THE EXPOSURE. Usually the integrator, not the contract named in `subject`. */
  affectedParty: string
  title: string
  /** Strictly factual, neutral engineering language. No accusation, no intent. */
  statement: string
  /** Quantified impact where it can be computed from chain state alone. */
  impact: {
    basisPoints?: number
    percent?: number
    note: string
  }
  evidence: Evidence[]
  /**
   * Off-chain inputs a finding relies on, disclosed with provenance.
   *
   * The byte-verified guarantee covers `evidence` ONLY. Where a claim also depends on a value that
   * cannot be fetched from chain state — an off-chain quote, a published directory — it is listed
   * here so a reader can tell which numbers carry the guarantee and which do not. Silence on this
   * is what let an absence claim ship under a verification badge.
   */
  offChainSources?: Array<{ url: string; describes: string; fetchedAt: string }>
  methodologyVersion: string
  detectedAt: string
}

/**
 * An observation that is TRUE and checkable but has no on-chain citation — typically an
 * ABSENCE (a feed that is not published anywhere).
 *
 * Kept deliberately separate from Finding so that the core guarantee — "every citation on
 * every published finding reproduces byte-for-byte" — stays literally true. An absence
 * cannot be proven by an eth_call, so it must not masquerade as one.
 */
export interface ChainNote {
  id: string
  severity: Severity
  title: string
  statement: string
  /** Where a third party can check this claim themselves. */
  sources: string[]
  observedAt: string
}
