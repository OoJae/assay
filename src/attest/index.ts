import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { VALIDATION_REGISTRY, validationRegistryAbi } from './registry.js'

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

export interface SelfAssessmentCriterion {
  /** The question asked. */
  question: string
  /** What was found, about ASSAY and nothing else. */
  finding: string
  /** Where a reader checks it. A path in the public repo, not a claim. */
  source: string
}

/**
 * What ASSAY attests about ITSELF.
 *
 * WHY THIS NO LONGER CARRIES FINDINGS. The previous document embedded whole third-party findings
 * — CRWD, SPY and NVDA by symbol, contract address, severity and full accusatory statement — into
 * the artifact hashed into an on-chain ValidationRegistry response. ASSAY's own publication rule
 * is that unsolicited statements about a named party are never written on-chain, and this was the
 * single on-chain write it had ever made. It also made the subject of a SELF-attestation ambiguous:
 * a reader resolving responseHash found a document mostly about other people.
 *
 * The corpus those findings came from is still described, as AGGREGATE COUNTS with a block number.
 * That is what supports the claim "the machine ran and reproduced its citations" without restating
 * anything about anyone else. The findings themselves live on the wall, which is off-chain, where
 * the publication rule allows them.
 */
export interface EvidenceDocument {
  schema: 'assay-self-attestation-v2'
  subject: { agentId: string; name: string; agentURI: string }
  validator: { address: string; agentId: string }
  /**
   * SELF-ISSUED, stated in the artifact rather than inferred from the fact that two fields match.
   * This is not third-party assurance and must never be read as any.
   */
  selfIssued: boolean
  independence: string
  /**
   * How the tag was reached. 'documented-self-assessment' means a human compared ASSAY's own
   * handling against the published gates and recorded the result — NOT that the SERV adjudicator
   * returned this verdict. The earlier document carried a rationale written in adjudicator
   * vocabulary ("under gate 4…") for a verdict the adjudicator never produced, which read as a
   * machine determination it was not.
   */
  basis: 'documented-self-assessment'
  tag: AttestationTag
  score: number
  methodologyVersion: string
  assessment: SelfAssessmentCriterion[]
  /** Aggregate evidence that the machine ran. No third party is named. */
  corpus: {
    sweptAtBlock: string
    assetsScanned: number
    findingsPublished: number
    citationsChecked: number
    citationsReproduced: number
    findingsWithheld: number
  }
  limitations: string[]
  issuedAt: string
}

export interface SelfAttestationInput {
  agentId: string
  agentName: string
  agentURI: string
  validatorAddress: string
  tag: AttestationTag
  methodologyVersion: string
  assessment: SelfAssessmentCriterion[]
  corpus: EvidenceDocument['corpus']
  limitations: string[]
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
export function buildEvidenceDocument(input: SelfAttestationInput): EvidenceDocument {
  return {
    schema: 'assay-self-attestation-v2',
    subject: { agentId: input.agentId, name: input.agentName, agentURI: input.agentURI },
    validator: { address: input.validatorAddress, agentId: input.agentId },
    selfIssued: true,
    independence:
      'NONE. The subject and the validator are the same key, so this carries no independent ' +
      'assurance whatsoever. It is published to exercise the solicited-attestation mechanism ' +
      'against a subject that consented — ASSAY — and to demonstrate the rule that ASSAY grades ' +
      'itself before it grades anyone else. Treat it as a disclosure, not as a rating.',
    basis: 'documented-self-assessment',
    tag: input.tag,
    score: scoreFor(input.tag),
    methodologyVersion: input.methodologyVersion,
    assessment: input.assessment,
    corpus: input.corpus,
    limitations: input.limitations,
    issuedAt: input.issuedAt,
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

const ZERO_HASH = `0x${'0'.repeat(64)}` as const

export interface ValidationRequestStatus {
  requestHash: `0x${string}`
  agentId: bigint
  answered: boolean
  tag: string
  response: number
  responseHash: `0x${string}`
  lastUpdate: bigint
}

/**
 * Decide whether a validation request has been ANSWERED.
 *
 * `lastUpdate` is stamped when the REQUEST is created, not when the response is written —
 * confirmed on-chain against our own request, whose lastUpdate was non-zero from the moment it
 * was made. Keying "answered" off it therefore reported every request as already handled, which
 * would have made the validator silently ignore every inbound request it ever received.
 *
 * `responseHash` is the honest signal: it is the zero word until a response is written, and
 * responses always carry a non-zero document hash.
 */
export function isAnswered(responseHash: `0x${string}`): boolean {
  return responseHash.toLowerCase() !== ZERO_HASH
}

export async function validationStatus(
  requestHash: `0x${string}`,
): Promise<ValidationRequestStatus> {
  const pub = publicBase()
  const status = (await pub.readContract({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    functionName: 'getValidationStatus',
    args: [requestHash],
  })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint]
  return {
    requestHash,
    agentId: status[1],
    response: status[2],
    responseHash: status[3],
    tag: status[4],
    lastUpdate: status[5],
    answered: isAnswered(status[3]),
  }
}

/** Every request addressed to us, with whether it has actually been answered. */
export async function validatorRequests(
  validator: `0x${string}`,
): Promise<ValidationRequestStatus[]> {
  const pub = publicBase()
  const hashes = (await pub.readContract({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    functionName: 'getValidatorRequests',
    args: [validator],
  })) as readonly `0x${string}`[]
  const out: ValidationRequestStatus[] = []
  for (const requestHash of hashes) out.push(await validationStatus(requestHash))
  return out
}

/** Requests addressed to us that we have not yet answered. */
export async function pendingRequests(
  validator: `0x${string}`,
): Promise<ValidationRequestStatus[]> {
  return (await validatorRequests(validator)).filter((r) => !r.answered)
}
