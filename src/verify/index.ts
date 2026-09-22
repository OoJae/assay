import { rhClient } from '../lib/chains.js'
import type { Evidence, Finding } from '../sweep/types.js'
import { encodeFunctionData } from 'viem'
import { stockTokenAbi, aggregatorV3Abi } from '../lib/abis.js'

/**
 * The anti-hallucination guarantee.
 *
 * Every Evidence item claims that a specific call against a specific contract at a
 * specific block returned specific bytes. Before anything is published we re-execute
 * that call and byte-compare. A citation that does not reproduce is DROPPED, never
 * softened — and a finding with no surviving evidence is dropped entirely.
 *
 * This lives in code, not in a prompt, because serv_shadow_agent can only validate
 * that a finding LOOKS like it carries a block number and a return value, not that
 * those values are true.
 */

const SIG_TO_ABI: Record<string, readonly unknown[]> = {
  'uiMultiplier()': stockTokenAbi,
  'newUIMultiplier()': stockTokenAbi,
  'effectiveAt()': stockTokenAbi,
  'oraclePaused()': stockTokenAbi,
  'totalSupply()': stockTokenAbi,
  'decimals()': stockTokenAbi,
  'latestRoundData()': aggregatorV3Abi,
}

export type VerificationStatus =
  /** Re-fetched and byte-identical. Publishable. */
  | 'reproduced'
  /** Re-fetched and DIFFERENT. The citation is wrong — drop it. */
  | 'mismatch'
  /** The node no longer serves that block. NOT evidence of fabrication. */
  | 'pruned'
  /** Call failed for another reason. */
  | 'error'

export interface VerificationResult {
  evidence: Evidence
  reproduced: boolean
  status: VerificationStatus
  actualReturn?: string
  reason?: string
}

/**
 * The public Robinhood Chain RPC is NOT an archive node — measured 2026-09-20 it serves
 * 5,000-10,000 blocks of history at 0.101s per block — measured by binary search, not estimated.
 * A citation
 * therefore becomes unverifiable within minutes.
 *
 * Consequence for the design: verification is FUSED INTO THE SWEEP at the same block, never
 * run as a later pass. We distinguish 'pruned' from 'mismatch' because conflating them would
 * be dishonest — a pruned citation is not a false one, it is merely no longer checkable here.
 */
export function isPrunedError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('historical') || m.includes('missing trie node') || m.includes('state not available')
}

export async function verifyEvidence(e: Evidence): Promise<VerificationResult> {
  const abi = SIG_TO_ABI[e.call]
  if (!abi)
    return { evidence: e, reproduced: false, status: 'error', reason: `unknown call signature: ${e.call}` }

  const functionName = e.call.replace('()', '')
  try {
    const data = encodeFunctionData({ abi: abi as never, functionName } as never)
    const actual = (await rhClient.request({
      method: 'eth_call',
      params: [{ to: e.contract, data }, `0x${BigInt(e.blockNumber).toString(16)}`],
    } as never)) as string

    if (actual.toLowerCase() !== e.rawReturn.toLowerCase()) {
      return {
        evidence: e,
        reproduced: false,
        status: 'mismatch',
        actualReturn: actual,
        reason: 'raw return mismatch',
      }
    }
    return { evidence: e, reproduced: true, status: 'reproduced', actualReturn: actual }
  } catch (err) {
    const msg = (err as Error).message
    if (isPrunedError(msg)) {
      return {
        evidence: e,
        reproduced: false,
        status: 'pruned',
        reason: 'block no longer served by this RPC (not an archive node) — citation is unchecked here, not disproven',
      }
    }
    return { evidence: e, reproduced: false, status: 'error', reason: `call failed: ${msg.slice(0, 120)}` }
  }
}

/**
 * Why a finding was not published. These are NOT interchangeable and must never be collapsed:
 *  - 'mismatch'          the citation contradicts chain state. This is the only one that impugns
 *                        the finding itself.
 *  - 'unverifiable_here' the node no longer serves that block. Unchecked, not disproven.
 *  - 'unchecked'         the re-fetch failed (transient RPC error after retries). Says nothing
 *                        about the finding's truth, only about our ability to confirm it.
 *  - 'no_evidence'       the finding arrived carrying NO citations at all. This is a defect in the
 *                        SWEEPER, not a statement about the subject. It gets its own reason because
 *                        folding it into 'unchecked' would let a detector bug that emits uncited
 *                        findings hide inside the same bucket as ordinary RPC flakiness, and folding
 *                        it into 'mismatch' would report a subject as fabricated on zero evidence.
 *
 * Reporting an RPC failure as 'mismatch' would be exactly the over-claim this tool exists to
 * avoid — asserting a defect when the honest statement is "we could not check".
 */
export type RejectionReason = 'mismatch' | 'unverifiable_here' | 'unchecked' | 'no_evidence'

export interface RejectedFinding {
  finding: Finding
  reason: RejectionReason
  detail: string
  results: VerificationResult[]
}

export interface VerifiedFinding extends Finding {
  verification: {
    checked: number
    reproduced: number
    mismatched: number
    pruned: number
    dropped: VerificationResult[]
    verifiedAt: string
  }
}

export type VerifyOutcome =
  | { ok: true; finding: VerifiedFinding }
  | { ok: false; rejected: RejectedFinding }

export async function verifyFindingDetailed(f: Finding): Promise<VerifyOutcome> {
  // A finding with no citations at all never reaches the byte comparison, so without this guard
  // it fell through to the kept.length === 0 ladder and was rejected as 'mismatch' — reporting a
  // sweeper bug as though the subject's chain state had contradicted us.
  if (f.evidence.length === 0) {
    return {
      ok: false,
      rejected: {
        finding: f,
        reason: 'no_evidence',
        detail: 'finding carries no citations — detector defect, not a statement about the subject',
        results: [],
      },
    }
  }

  const results = await Promise.all(f.evidence.map(verifyEvidence))
  const kept = results.filter((r) => r.reproduced).map((r) => r.evidence)
  const dropped = results.filter((r) => !r.reproduced)
  const mismatched = results.filter((r) => r.status === 'mismatch').length
  const pruned = results.filter((r) => r.status === 'pruned').length

  // A single mismatched citation discredits the finding outright — that is fabrication.
  if (mismatched > 0) {
    return {
      ok: false,
      rejected: {
        finding: f,
        reason: 'mismatch',
        detail: `${mismatched} citation(s) did not reproduce byte-for-byte`,
        results,
      },
    }
  }

  // No reproducible evidence. CRUCIAL: distinguish "we cannot check" from "it is false".
  const errored = results.filter((r) => r.status === 'error').length
  if (kept.length === 0) {
    const reason: RejectionReason =
      pruned > 0 ? 'unverifiable_here' : errored > 0 ? 'unchecked' : 'mismatch'
    const detail =
      pruned > 0
        ? `${pruned} citation(s) reference a block this RPC no longer serves — unchecked, not disproven`
        : errored > 0
          ? `${errored} citation(s) could not be re-fetched (RPC error after retries) — unchecked, not disproven`
          : 'no citation could be reproduced'
    return { ok: false, rejected: { finding: f, reason, detail, results } }
  }

  return {
    ok: true,
    finding: {
    ...f,
    evidence: kept,
    verification: {
      checked: results.length,
      reproduced: kept.length,
      mismatched,
      pruned,
      dropped,
      verifiedAt: new Date().toISOString(),
    },
    },
  }
}

/** Back-compat helper: null on any rejection. Prefer verifyFindingDetailed. */
export async function verifyFinding(f: Finding): Promise<VerifiedFinding | null> {
  const r = await verifyFindingDetailed(f)
  return r.ok ? r.finding : null
}

export async function verifyAll(findings: Finding[]): Promise<{
  verified: VerifiedFinding[]
  rejected: RejectedFinding[]
}> {
  const verified: VerifiedFinding[] = []
  const rejected: RejectedFinding[] = []
  for (const f of findings) {
    const r = await verifyFindingDetailed(f)
    if (r.ok) verified.push(r.finding)
    else rejected.push(r.rejected)
  }
  return { verified, rejected }
}
