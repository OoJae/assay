import type { Verdict } from '../serv.js'
import type { UsageSummary } from '../harness.js'
import type { VerifiedFinding } from '../../verify/index.js'

/**
 * Types for the held-out SERV evaluation (see PROTOCOL.md).
 *
 * A held-out case is a mandate adjudicated against one of a small number of FIXED findings, copied
 * verbatim from the public board into fixtures.json. Nothing is swept: the adjudicator's input is
 * byte-identical on every draw and arm, so a difference between draws is the adjudicator's.
 */

/** The fixtures in fixtures.json, keyed by the finding class they stand for. */
export const FIXTURE_KEYS = ['SHARE', 'CROSS', 'STALE'] as const
export type FixtureKey = (typeof FIXTURE_KEYS)[number]

/**
 * The defect class each fixture key must carry. A fixture pasted under the wrong key would run
 * every mandate written for one class against another class's evidence, and nothing downstream
 * would notice. PROTOCOL.md names ORACLE_STALE_MARKET_CLOSED as the STALE capture class.
 */
export const FIXTURE_DEFECT_CLASS: Record<FixtureKey, string> = {
  SHARE: 'SHARE_COUNT_MISREAD_RISK',
  CROSS: 'CROSS_SURFACE_PRICE_MIX',
  STALE: 'ORACLE_STALE_MARKET_CLOSED',
}

export interface HeldoutCase {
  id: string
  /** Which fixture in fixtures.json this mandate is adjudicated against. */
  fixture: FixtureKey
  /** The subject's declared mandate: untrusted text, sent to the adjudicator verbatim. */
  mandate: string
  /** The label the case is scored against. For a scored case all three labels below equal it. */
  label: Verdict
  /** The gate that decides the label (1 WITHHELD, 2 BENIGN, 3 CONTROL_WEAKNESS, 4 BENIGN or MATERIAL_MISSTATEMENT). */
  gate: 1 | 2 | 3 | 4
  /** `scored` when the three independent labels agree; any disagreement makes it `contested`, kept out of the headline. */
  status: 'scored' | 'contested'
  labels: { writer: Verdict; labellerA: Verdict; labellerB: Verdict }
  /** Why the writer labelled it so, from GUIDE.md's definitions. */
  rationale: string
}

/** fixtures.json. STALE is absent until it is captured under PROTOCOL.md's rule. */
export interface FixturesFile {
  source?: string
  capturedFromBoard?: unknown
  note?: string
  fixtures: Partial<Record<FixtureKey, VerifiedFinding>>
}

export type Arm = 'braid-on' | 'braid-off'

/** A draw's outcome: the verdict, or ERROR when the call produced none. Errors stay in every denominator. */
export type Outcome = Verdict | 'ERROR'

/** A case's modal outcome across its draws in one arm. SPLIT when no outcome is uniquely most frequent (a 2-2 split). */
export type ModalOutcome = Outcome | 'SPLIT'

/** One adjudication call, kept whole: a row with verdicts only cannot attribute a refusal to a gate. */
export interface HeldoutTrial {
  draw: number
  verdict: Verdict | null
  severity: string | null
  rationale: string | null
  bindingEvidence: string[] | null
  withheldReason: string | null
  finishReason: string | null
  latencyMs: number
  usage: { promptTokens: number; completionTokens: number } | null
  /** keccak256 of the exact user message. On an errored call, of the message that was sent. */
  inputHash: string
  /** Set when the call produced no verdict: an AdjudicatorError, an HTTP error, a timeout. */
  error: string | null
}

/** One case in one arm: n draws. A row that exists is done, errors and all. */
export interface HeldoutRow {
  id: string
  fixture: FixtureKey
  findingId: string
  arm: Arm
  label: Verdict
  status: HeldoutCase['status']
  labels: HeldoutCase['labels']
  /** Index into the artifact's `invocations`: which process run produced this row. */
  invocation: number
  model: string
  /** keccak256 of the user message this case sends. Identical on every draw and both arms. */
  inputHash: string
  attempted: number
  completed: number
  errored: number
  /** Completed verdicts, in draw order. */
  verdicts: Verdict[]
  /** Every draw's outcome in draw order, ERROR included. The modal verdict is computed from this. */
  outcomes: Outcome[]
  /** Draws whose verdict equals the label. */
  correct: number
  modal: ModalOutcome
  modalCorrect: boolean
  trials: HeldoutTrial[]
  usage: UsageSummary
}

export interface WilsonInterval {
  lower: number
  upper: number
}

export type ConfusionMatrix = Record<string, Record<string, number>>

export interface FixtureSummary {
  cases: number
  correct: number
  accuracy: number | null
  wilson95: WilsonInterval | null
  drawsAttempted: number
  drawsCorrect: number
  drawAccuracy: number | null
}

export interface ArmSummary {
  arm: Arm
  /**
   * THE HEADLINE. Scored cases only; a case is correct when its modal outcome across the draws
   * equals the label, and a split (2-2) or an error mode counts as incorrect.
   */
  headline: { cases: number; correct: number; accuracy: number | null; wilson95: WilsonInterval | null }
  /** Scored cases, every draw. `accuracy` has errored calls in the denominator. */
  perDraw: {
    attempted: number
    completed: number
    errored: number
    correct: number
    accuracy: number | null
    accuracyOverCompleted: number | null
  }
  /** Scored cases. Rows are the label, columns the outcome. */
  confusion: { draws: ConfusionMatrix; modal: ConfusionMatrix }
  perFixture: Partial<Record<FixtureKey, FixtureSummary>>
  /** MATERIAL_MISSTATEMENT where the label is not, over scored cases. */
  overAccusations: { draws: number; cases: number; caseIds: string[] }
  /** BENIGN where the label is not, over scored cases. */
  missedDefects: { draws: number; cases: number; caseIds: string[] }
  errored: { scored: number; contested: number; total: number; pairsWithErrors: number }
  /** Every call in the arm, contested cases included: the cost is the cost. */
  usage: UsageSummary
  /** Run and reported, never in the headline. */
  contested: Array<{
    id: string
    fixture: FixtureKey
    labels: HeldoutCase['labels']
    modal: ModalOutcome
    outcomes: Outcome[]
  }>
}

export interface HeldoutFixtureRecord {
  id: string
  defectClass: string
  methodologyVersion: string
  /** keccak256 of the fixture's JSON, so a resume can prove it replays the same input. */
  hash: string
  /** Verbatim, so every inputHash in the artifact can be recomputed from the artifact alone. */
  finding: VerifiedFinding
}

export interface HeldoutInvocation {
  at: string
  gitHead: string
  casesFileHash: string
  fixturesFileHash: string
  /** The harness script differed from HEAD when this invocation ran. Recorded, not refused. */
  harnessUncommitted: boolean
  fixtureKeys: FixtureKey[]
  /**
   * Set when the invocation stopped on an authentication or billing failure (HTTP 401/402/403):
   * those calls never reached the adjudicator, so they are not scored. The pair in flight is kept
   * here, whole, and runs again on resume.
   */
  aborted?: string
  abortedPair?: { id: string; arm: Arm; trials: HeldoutTrial[] }
}

export interface HeldoutArtifact {
  kind: 'heldout-trials'
  runId: string
  generatedAt: string
  updatedAt: string
  complete: boolean
  /** A --dev run uses the cheap model and is NOT the pre-registered evaluation. */
  dev: boolean
  model: string
  heldoutVersion: string
  /** The adjudication rubric version. `planRun` compares it on resume. */
  methodologyVersion: string
  detectionMethodologyVersion: string
  rubricFingerprint: string
  casesFileHash: string
  trialsPerCase: number
  fixtureKeys: FixtureKey[]
  fixtures: Partial<Record<FixtureKey, HeldoutFixtureRecord>>
  cases: HeldoutCase[]
  notRun: Array<{ id: string; fixture: FixtureKey; reason: string }>
  invocations: HeldoutInvocation[]
  results: HeldoutRow[]
  summary: { braidOn: ArmSummary; braidOff: ArmSummary }
  rubricVersion: string
  inputHashes: string[]
  usage: { promptTokens: number; completionTokens: number; estimatedUsd: number; basis: string }
}
