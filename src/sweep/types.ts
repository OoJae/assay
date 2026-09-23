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
  /**
   * Renamed from SHARE_COUNT_MISREPORT. Nothing MISREPORTS anything here: a Stock Token that
   * moves uiMultiplier() is doing exactly what ERC-8056 specifies. The exposure is a RISK borne
   * by an integrator that reads balanceOf() as a share count. The old name screenshotted as
   * "ASSAY flags CRWD critical", which is an accusation against a compliant contract.
   */
  | 'SHARE_COUNT_MISREAD_RISK'
  /**
   * A contract HOLDING a Stock Token whose deployed bytecode contains no uiMultiplier() selector,
   * so it cannot call it directly. The counterpart to SHARE_COUNT_MISREAD_RISK: that class names
   * the asset that was read, this one names a party that reads it.
   *
   * Strictly an absence-of-capability claim, proven by eth_getCode and re-runnable by the verifier.
   * It is NOT a claim that the contract misvalues anything — see src/sweep/integrators.ts. AMM
   * pools, pool managers, custody wallets and distributors are never this class (their verdict is
   * NOT_APPLICABLE), and neither is a holding below the materiality floor.
   */
  | 'INTEGRATOR_NOT_MULTIPLIER_AWARE'
  | 'ORACLE_PAUSED'
  | 'PENDING_CORPORATE_ACTION'

/*
 * DELIBERATELY ABSENT, and this is load-bearing rather than tidiness.
 *
 * NO_PRICE_FEED and SEQUENCER_FEED_UNAVAILABLE were in this union and are emitted as ChainNotes
 * instead, because an absence that no single RPC read can prove must not carry the byte-verified
 * badge. VAULT_DECIMAL_SCALE, VAULT_WHITELIST and VAULT_ASYNC_SETTLEMENT were declared for an IXS
 * path that was never built and has no detector.
 *
 * All five were filterable through assay_findings, so a caller asking for any of them got a
 * valid-schema empty list forever — exactly the defect fixed once already for the nonexistent
 * STALE_ORACLE_PAST_HEARTBEAT (see src/mcp/server.ts). A filter that silently answers "none" to a
 * question it cannot answer is worse than one that rejects it.
 */

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
  /**
   * The exact calldata sent, for a call that takes arguments (e.g. "balanceOf(address)").
   *
   * A signature alone cannot be re-run when the call has arguments: `balanceOf(address)` cited
   * without the holder is a promise nobody can check. Absent for argument-less calls, whose
   * calldata is just the selector.
   */
  calldata?: `0x${string}`
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
  /**
   * Quantified impact where it can be computed from chain state alone.
   *
   * `basisPoints` and `percent` are ONE quantity in two units (basisPoints = percent x 100), and
   * `measures` says what that quantity is. The share-count page used to render "30,000 bps · 75%"
   * for CRWD: basisPoints was |m - 1| and percent was |1 - 1/m|, two different measures side by
   * side, and the first was the "300%" framing the project had already retired as an overclaim.
   */
  impact: {
    basisPoints?: number
    percent?: number
    /** What `percent` measures, in words, so no surface has to guess. */
    measures?: string
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
