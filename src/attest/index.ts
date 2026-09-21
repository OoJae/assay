import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { VALIDATION_REGISTRY, validationRegistryAbi } from './registry.js'
import type { VerifiedFinding } from '../verify/index.js'

/**
 * SOLICITED-ONLY ATTESTATION.
 *
 * ASSAY never initiates an on-chain statement about a third party. A subject calls
 * validationRequest(validator=ASSAY, agentId, requestURI, requestHash) naming us; only then do we
 * answer with validationResponse(). Unsolicited findings stay off-chain as facts on the wall.
 *
 * That single rule is what keeps this defensible: the only on-chain claim ASSAY makes about a
 * named party is one that party asked for.
 *
 * response is uint8 0..100 (higher is better), per the ERC-8004 validation profile.
 */
export const RESPONSE_SCALE = { min: 0, max: 100 } as const

export type AttestationTag = 'CLEAN' | 'CONTROL_WEAKNESS' | 'MATERIAL_MISSTATEMENT' | 'WITHHELD'

/** Map our adjudication vocabulary onto the registry's 0..100 score plus a tag. */
export function scoreFor(tag: AttestationTag): number {
  switch (tag) {
    case 'CLEAN':
      return 100
    case 'CONTROL_WEAKNESS':
      return 60
    case 'MATERIAL_MISSTATEMENT':
      return 20
    case 'WITHHELD':
      // Not a grade. Withholding means the evidence did not support a conclusion, and a score
      // would imply one. 50 is recorded alongside the explicit WITHHELD tag so readers can filter.
      return 50
  }
}

export interface EvidenceDocument {
  agentId: string
  tag: AttestationTag
  score: number
  methodologyVersion: string
  rationale: string
  observedAtBlock: string
  findings: Array<{
    id: string
    defectClass: string
    severity: string
    title: string
    statement: string
    citations: Array<{ claim: string; contract: string; call: string; rawReturn: string; blockNumber: string }>
  }>
  issuedAt: string
}

/**
 * Build the evidence document.
 *
 * DETERMINISTIC BY CONSTRUCTION. `issuedAt` is passed in, not stamped from the clock, and the
 * block is passed in rather than re-swept. The earlier version stamped `new Date()` and re-swept
 * per call, so no two runs produced the same bytes — which is how the on-chain responseHash came
 * to disagree with the published document. The bytes MUST be reproducible, or responseHash proves
 * nothing.
 */
export function buildEvidenceDocument(
  agentId: string,
  tag: AttestationTag,
  rationale: string,
  methodologyVersion: string,
  block: string,
  findings: VerifiedFinding[],
  issuedAt: string,
): EvidenceDocument {
  return {
    agentId,
    tag,
    score: scoreFor(tag),
    methodologyVersion,
    rationale,
    observedAtBlock: block,
    findings: findings.map((f) => ({
      id: f.id,
      defectClass: f.defectClass,
      severity: f.severity,
      title: f.title,
      statement: f.statement,
      citations: f.evidence.map((e) => ({
        claim: e.claim,
        contract: e.contract,
        call: e.call,
        rawReturn: e.rawReturn,
        blockNumber: e.blockNumber,
      })),
    })),
    issuedAt,
  }
}

/**
 * Hash the EXACT bytes that will be served at responseURI.
 *
 * The point of responseHash is that a third party can fetch the document, hash it, and confirm the
 * attestation refers to the evidence we actually published. So the bytes hashed here must be the
 * bytes written to disk — hence callers pass the serialised string, not the object.
 */
export function hashDocument(serialised: string): `0x${string}` {
  return keccak256(toHex(serialised))
}

export function publicBase() {
  return createPublicClient({ chain: base, transport: http() })
}

export function walletFor(pk: `0x${string}`) {
  return createWalletClient({ account: privateKeyToAccount(pk), chain: base, transport: http() })
}

/** Requests addressed to us that we have not yet answered. */
export async function pendingRequests(validator: `0x${string}`) {
  const pub = publicBase()
  const hashes = (await pub.readContract({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    functionName: 'getValidatorRequests',
    args: [validator],
  })) as readonly `0x${string}`[]

  const out: Array<{ requestHash: `0x${string}`; agentId: bigint; answered: boolean }> = []
  for (const requestHash of hashes) {
    const status = (await pub.readContract({
      address: VALIDATION_REGISTRY,
      abi: validationRegistryAbi,
      functionName: 'getValidationStatus',
      args: [requestHash],
    })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint]
    // lastUpdate is non-zero once a response has been written.
    out.push({ requestHash, agentId: status[1], answered: status[5] > 0n })
  }
  return out
}
