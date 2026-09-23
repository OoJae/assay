import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { IDENTITY_REGISTRY, VALIDATION_REGISTRY, validationRegistryAbi } from './registry.js'
import { isNamedIntegrator } from '../lib/redact.js'
// Type-only on purpose. The submit half of the solicited flow must not be able to reach the sweep
// or the SERV client, and a value import from either would put them in its module graph.
import type { Verdict } from '../adjudicate/serv.js'

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

/** Where every published document is served from. responseURI and requestURI are built on it. */
export const WALL_ORIGIN = 'https://assay-steel.vercel.app'

/** CAIP-10-style registry id, as ERC-8004 `registrations[].agentRegistry` spells it. */
export const AGENT_REGISTRY = `eip155:8453:${IDENTITY_REGISTRY}`

export type AttestationTag =
  | 'CLEAN'
  | 'NO_MATERIAL_EXPOSURE_AS_DECLARED'
  | 'CONTROL_WEAKNESS'
  | 'MATERIAL_MISSTATEMENT'
  | 'WITHHELD'

/** Map our adjudication vocabulary onto the registry's 0..100 score plus a tag. */
export function scoreFor(tag: AttestationTag): number {
  switch (tag) {
    case 'CLEAN':
      return 100
    case 'NO_MATERIAL_EXPOSURE_AS_DECLARED':
      // Below CLEAN because nothing corroborates it. Every gate asks what the mandate STATES, so a
      // subject that writes the right sentence into its own card reaches BENIGN; scoring that 100
      // let a card edit buy the top of the scale under ASSAY's validator key.
      return 80
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

/**
 * Map the adjudicator's vocabulary onto the registry's, for a SOLICITED verdict.
 *
 * BENIGN is not CLEAN. The adjudicator grades declared text, so BENIGN says "as declared, the
 * subject is not exposed" — and the tag says exactly that instead of a word that reads as a
 * clean bill of health for behaviour nobody observed.
 */
export function tagForVerdict(verdict: Verdict): AttestationTag {
  switch (verdict) {
    case 'BENIGN':
      return 'NO_MATERIAL_EXPOSURE_AS_DECLARED'
    case 'CONTROL_WEAKNESS':
      return 'CONTROL_WEAKNESS'
    case 'MATERIAL_MISSTATEMENT':
      return 'MATERIAL_MISSTATEMENT'
    case 'WITHHELD':
      return 'WITHHELD'
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
 * A verdict ASSAY issues about SOMEONE ELSE, because they asked.
 *
 * Its own schema, not the self document with other values. attest:respond used to pass a third
 * party through buildEvidenceDocument, whose fields are fixed for the self case, so the document
 * it would have anchored on Base said the verdict was self-issued, that ASSAY and the subject were
 * the same key, that the validator was the subject's own agentId, and that no model was involved —
 * while its limitations said the opposite. Nothing here is shared with that builder, so neither
 * can be called with the other's input by mistake.
 */
export interface SolicitedDocument {
  schema: 'assay-solicited-attestation-v1'
  /** The first thing a reader sees: what was graded, and what was not. */
  graded: string
  /** cardHash is keccak256 of the card bytes as read, so the mandate graded stays checkable after the card changes. */
  subject: { agentId: string; name: string; agentURI: string; cardHash: `0x${string}` }
  /** ASSAY's own canonical identity, never the subject's. */
  validator: { address: string; agentId: string }
  selfIssued: false
  independence: string
  basis: 'serv-adjudicated-against-declared-mandate'
  request: {
    requestHash: `0x${string}`
    requestURI: string
    /** Which finding decided the tag, and who chose it. */
    scope: { findingId: string; defectClass: string; chosenBy: 'requester' | 'default' }
  }
  tag: AttestationTag
  score: number
  verdict: Verdict
  severity: string
  adjudication: {
    /** The rubric that produced the verdict (adjudicate/methodology.ts), not the detector's. */
    rubricVersion: string
    /** The detection methodology that produced the finding (sweep/detect.ts). */
    detectionVersion: string
    model: string
    /** keccak256 of the exact user message sent, including the subject's mandate. */
    inputHash: `0x${string}`
    promptGuardTriggered: boolean
    finishReason: string
    sweptAtBlock: string
  }
  assessment: SelfAssessmentCriterion[]
  limitations: string[]
  issuedAt: string
}

export interface SolicitedInput {
  requestHash: `0x${string}`
  requestURI: string
  scope: SolicitedDocument['request']['scope']
  subject: SolicitedDocument['subject']
  validator: SolicitedDocument['validator']
  verdict: Verdict
  severity: string
  rationale: string
  /** Already filtered by checkPublishable to claims quoted verbatim from the bundle. */
  bindingEvidence: string[]
  withheldReason: string | null
  adjudication: SolicitedDocument['adjudication']
  issuedAt: string
}

export function buildSolicitedDocument(input: SolicitedInput): SolicitedDocument {
  if (input.subject.agentId === input.validator.agentId) {
    throw new Error('subject and validator are the same identity: that is a self-attestation, use buildEvidenceDocument')
  }
  if (isNamedIntegrator({ defectClass: input.scope.defectClass })) {
    // A named-integrator finding names a third-party CONTRACT, and nothing public may name one.
    throw new Error(`${input.scope.defectClass} findings never go into a published document`)
  }
  const tag = tagForVerdict(input.verdict)
  const source = `block ${input.adjudication.sweptAtBlock} on Robinhood Chain 4663`
  return {
    schema: 'assay-solicited-attestation-v1',
    graded:
      "The subject's DECLARED handling, as written in its own agent card, against one verified " +
      "finding. The subject's behaviour was not observed; this says nothing about what it does.",
    subject: input.subject,
    validator: input.validator,
    selfIssued: false,
    independence:
      'ASSAY and the subject are different keys and different ERC-8004 identities, and ASSAY has ' +
      'no control path over the subject. The subject asked for this verdict by naming ASSAY in ' +
      'validationRequest(); ASSAY did not initiate it. The verdict grades text the subject wrote.',
    basis: 'serv-adjudicated-against-declared-mandate',
    request: { requestHash: input.requestHash, requestURI: input.requestURI, scope: input.scope },
    tag,
    score: scoreFor(tag),
    verdict: input.verdict,
    severity: input.severity,
    adjudication: input.adjudication,
    assessment: [
      {
        question: 'What did the subject declare it does, and does this finding fall inside it?',
        finding: input.rationale,
        source: input.subject.agentURI,
      },
      ...input.bindingEvidence.map((claim, i) => ({ question: `Binding evidence ${i + 1}`, finding: claim, source })),
    ],
    limitations: [
      'SOLICITED: this verdict was requested by the subject. It is not an unsolicited rating.',
      'Grades DECLARED handling only. A subject that declares correct handling reaches ' +
        'NO_MATERIAL_EXPOSURE_AS_DECLARED (80), not a clean score, because nothing here corroborates the declaration.',
      input.scope.chosenBy === 'requester'
        ? `The subject named the finding (${input.scope.findingId}) in its request document.`
        : `The request named no finding, so the documented default was used (${input.scope.findingId}). ` +
          'That is not evidence the subject holds or reads this asset.',
      `Adjudicated by SERV Reasoning (${input.adjudication.model}) under rubric ` +
        `${input.adjudication.rubricVersion}, on a finding from detection methodology ` +
        `${input.adjudication.detectionVersion}. The model is not deterministic, so the inputs are ` +
        'identified by inputHash rather than claimed to reproduce the same verdict.',
      'The mandate text is authored by the party being graded and was treated as hostile input; ' +
        'serv_prompt_guard was enabled, and the output was checked before publication.',
      ...(input.withheldReason ? [`WITHHELD: ${input.withheldReason}`] : []),
      'Informational only: an automated reading of public chain state and of text the subject ' +
        'published. Not investment, financial or legal advice, and not a security audit. ASSAY is ' +
        'independent and is not affiliated with, endorsed by, or officially connected with ' +
        'Robinhood Markets, Inc. or Chainlink Labs.',
    ],
    issuedAt: input.issuedAt,
  }
}

/**
 * The words the rubric's TONE section forbids. Enforced here too, because the only enforcement was
 * the model reading its own instructions.
 */
const BANNED_WORDS = ['fraud', 'scam', 'negligent', 'dishonest', 'reckless'] as const

export const PUBLICATION_LIMITS = {
  rationaleChars: 1200,
  withheldReasonChars: 400,
  bindingEvidence: 8,
  /** A verbatim run this long from the subject's mandate is an echo, not a description of it. */
  echoChars: 80,
  /** Shorter runs count when they come from a sentence addressed to the adjudicator. */
  instructionEchoChars: 30,
} as const

/** Words that address the adjudicator rather than describe the subject: the shape of an injection. */
const INSTRUCTION_LIKE =
  /\b(ignore|disregard|override|forget|you must|you should|you are|verdict|adjudicat\w*|assistant|system prompt|instructions?|rubric|gates?|benign|clean|withheld|material_misstatement|control_weakness)\b/i

export interface EvidenceBundle {
  /** Every evidence claim string, which binding_evidence must quote verbatim. */
  claims: string[]
  /** Addresses the rationale may name: the finding's own contracts. */
  addresses: string[]
  /** Text numbers may come from: the user message sent plus the rubric. */
  text: string
}

export interface PublicationCheck {
  ok: boolean
  problems: string[]
  /** binding_evidence entries that quote the bundle verbatim, capped. */
  bindingEvidence: string[]
  /** Entries dropped because they did not. Recorded in the sidecar, never published. */
  droppedEvidence: string[]
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Whether `text` contains any verbatim run of `size` characters from `source`, ignoring case and spacing. */
function echoes(text: string, source: string, size: number): boolean {
  const t = squash(text)
  const s = squash(source)
  if (s.length < size) return false
  for (let i = 0; i + size <= s.length; i++) if (t.includes(s.slice(i, i + size))) return true
  return false
}

/**
 * Decide whether an adjudication may be PUBLISHED under ASSAY's domain and validator key.
 *
 * WHY THIS EXISTS. The rationale and binding_evidence went into the hashed document verbatim, and
 * the mandate that shaped them is written by the party being graded. The rubric asks the model to
 * quote only the bundle and to avoid certain words, but nothing on our side checked, so a card
 * could steer what ASSAY anchored on Base. Every check here is deterministic and cheap; a failure
 * means nothing is published, and the operator sees why.
 */
export function checkPublishable(
  a: { verdict: string; rationale: string; binding_evidence: string[]; withheld_reason?: string | null },
  bundle: EvidenceBundle,
  mandate: string,
): PublicationCheck {
  const problems: string[] = []
  // Spelled out rather than imported: a value import of serv.ts would pull the SERV client into
  // this module's graph, which the submit step must not have.
  const verdicts: readonly string[] = ['MATERIAL_MISSTATEMENT', 'CONTROL_WEAKNESS', 'BENIGN', 'WITHHELD']
  if (!verdicts.includes(a.verdict)) problems.push(`unknown verdict ${JSON.stringify(a.verdict).slice(0, 40)}`)

  const rationale = a.rationale ?? ''
  const withheld = a.withheld_reason ?? ''
  if (!rationale.trim()) problems.push('empty rationale')
  if (rationale.length > PUBLICATION_LIMITS.rationaleChars) {
    problems.push(`rationale is ${rationale.length} chars (limit ${PUBLICATION_LIMITS.rationaleChars})`)
  }
  if (withheld.length > PUBLICATION_LIMITS.withheldReasonChars) {
    problems.push(`withheld_reason is ${withheld.length} chars (limit ${PUBLICATION_LIMITS.withheldReasonChars})`)
  }

  const claims = new Set(bundle.claims.map((c) => c.trim()))
  const quoted = a.binding_evidence.map((b) => b.trim())
  const bindingEvidence = [...new Set(quoted.filter((b) => claims.has(b)))].slice(0, PUBLICATION_LIMITS.bindingEvidence)
  const droppedEvidence = quoted.filter((b) => !claims.has(b))
  if (a.verdict !== 'WITHHELD' && bindingEvidence.length === 0) {
    problems.push('no binding_evidence entry quotes the evidence bundle verbatim')
  }

  const allowedAddresses = new Set(bundle.addresses.map((x) => x.toLowerCase()))
  const allowedDigits = bundle.text.replace(/[,_]/g, '')
  const mandateSentences = mandate.split(/(?<=[.!?\n])\s+/)
  for (const [field, text] of [['rationale', rationale], ['withheld_reason', withheld]] as const) {
    if (!text) continue
    if (/\b(?:https?|ipfs|ftp):\/\/|\bdata:[\w.+-]+\/|\bjavascript:|\bwww\.[a-z0-9-]+\./i.test(text)) {
      problems.push(`${field} contains a URL`)
    }
    for (const addr of text.match(/0x[0-9a-fA-F]{40}/g) ?? []) {
      if (!allowedAddresses.has(addr.toLowerCase())) problems.push(`${field} names an address outside the finding: ${addr}`)
    }
    for (const word of BANNED_WORDS) {
      if (new RegExp(`\\b${word}`, 'i').test(text)) problems.push(`${field} uses a word the rubric forbids: ${word}`)
    }
    // Numbers of 4+ digits must exist in what the model was given. The rubric already asks for
    // this; it is the cheapest sign of an invented or injected figure.
    for (const n of text.match(/\d[\d,_.]*\d/g) ?? []) {
      const digits = n.replace(/[,_]/g, '')
      if (digits.replace(/\D/g, '').length >= 4 && !allowedDigits.includes(digits)) {
        problems.push(`${field} contains a number absent from the evidence: ${n}`)
      }
    }
    if (/DECLARED_MANDATE/.test(text)) problems.push(`${field} echoes the mandate delimiter`)
    if (echoes(text, mandate, PUBLICATION_LIMITS.echoChars)) problems.push(`${field} copies the subject's mandate verbatim`)
    else if (
      mandateSentences.some(
        (s) => INSTRUCTION_LIKE.test(s) && echoes(text, s, PUBLICATION_LIMITS.instructionEchoChars),
      )
    ) {
      problems.push(`${field} echoes an instruction from the subject's mandate`)
    }
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)], bindingEvidence, droppedEvidence }
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

/**
 * Hash RAW bytes — a file read from disk, or a fetched body — with no decoding step.
 *
 * Every check used to hash `await res.text()`, and Response.text() strips a UTF-8 BOM: a served
 * file with one prepended still passed ASSAY's own verifier while a raw-byte verifier rejected it.
 * Two honest verifiers must not disagree, so nothing here decodes before hashing.
 */
export function hashBytes(bytes: Uint8Array): `0x${string}` {
  return keccak256(bytes)
}

export function publicBase() {
  return createPublicClient({ chain: base, transport: http() })
}

export function walletFor(pk: `0x${string}`) {
  return createWalletClient({ account: privateKeyToAccount(pk), chain: base, transport: http() })
}

/**
 * Where a request's documents live, keyed by requestHash.
 *
 * Keyed by agentId alone, a second request from the same subject — or a dry run followed by the
 * next deploy — replaced the bytes an earlier on-chain responseHash committed to, which is the
 * incident attest-build.ts records. One request, one path, never reused.
 */
export function attestationPaths(agentId: string, requestHash: `0x${string}`) {
  const h = requestHash.toLowerCase()
  const dir = `attestations/${agentId}`
  return {
    document: `web/public/${dir}/${h}.json`,
    responseURI: `${WALL_ORIGIN}/${dir}/${h}.json`,
    requestDocument: `web/public/${dir}/${h}.request.json`,
    requestURI: `${WALL_ORIGIN}/${dir}/${h}.request.json`,
  }
}

/** The prepare step's record for a solicited request: everything submit needs, and why. */
export function respondSidecarPath(requestHash: `0x${string}`): string {
  return `data/attestation-respond-${requestHash.toLowerCase()}.json`
}

/**
 * What a validation request asks for. requestHash is keccak256 of these exact bytes.
 *
 * The self path used to commit to keccak256 of a fixed URL string, so every self-request for every
 * agentId had the same requestHash — and that hash was already taken by frozen 95265's request, so
 * the canonical identity could never be attested at all. Carrying agentId and issuedAt makes each
 * request its own commitment, and publishing the document is what ERC-8004 means by requestHash:
 * "a commitment to the request data".
 */
export interface ValidationRequestDocument {
  schema: 'assay-validation-request-v1'
  agentRegistry: string
  agentId: string
  validator: string
  kind: 'self-attestation' | 'solicited'
  /** For a solicited request: the finding the subject wants graded. Optional; see DEFAULT_SOLICITED_SCOPE. */
  scope?: { findingId?: string; symbol?: string; defectClass?: string }
  rules: string
  issuedAt: string
}

export function buildRequestDocument(
  input: Omit<ValidationRequestDocument, 'schema' | 'agentRegistry' | 'rules'>,
): ValidationRequestDocument {
  return {
    schema: 'assay-validation-request-v1',
    agentRegistry: AGENT_REGISTRY,
    agentId: input.agentId,
    validator: input.validator,
    kind: input.kind,
    ...(input.scope ? { scope: input.scope } : {}),
    rules: 'https://github.com/OoJae/assay#publication-ethics',
    issuedAt: input.issuedAt,
  }
}

/**
 * The finding a solicited verdict is decided on when the request names none.
 *
 * A request document may name a finding (`scope.findingId`, e.g. "NVDA-share-count") or a symbol
 * and defect class. Without one, attest:respond used to take whatever finding a sweep returned
 * first, so the grade depended on asset order. The default is fixed and written into the document:
 * SHARE_COUNT_MISREAD_RISK is present at every block (a completed corporate action, not a market-
 * hours condition), it is the class the hard adjudication set measures, and CRWD carries it.
 */
export const DEFAULT_SOLICITED_SCOPE = { symbol: 'CRWD', defectClass: 'SHARE_COUNT_MISREAD_RISK' } as const

export interface ResolvedScope {
  symbol: string
  findingId?: string
  defectClass?: string
  chosenBy: 'requester' | 'default'
}

/**
 * Read the scope out of a request document, or fall back to the default. Pure.
 *
 * The request's own content is used only when its bytes hash to requestHash: otherwise the scope
 * would come from a document the subject never committed to on-chain.
 */
export function resolveScope(requestBytes: Uint8Array | null, requestHash: `0x${string}`): ResolvedScope & { note: string } {
  const fallback = { ...DEFAULT_SOLICITED_SCOPE, chosenBy: 'default' as const }
  if (!requestBytes) return { ...fallback, note: 'request document unreadable' }
  if (hashBytes(requestBytes).toLowerCase() !== requestHash.toLowerCase()) {
    return { ...fallback, note: 'request document does not hash to requestHash; its contents were not used' }
  }
  let doc: { scope?: { findingId?: unknown; symbol?: unknown; defectClass?: unknown } }
  try {
    doc = JSON.parse(new TextDecoder().decode(requestBytes))
  } catch {
    return { ...fallback, note: 'request document is not JSON' }
  }
  const s = doc?.scope
  const str = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : undefined)
  const findingId = str(s?.findingId)
  const defectClass = str(s?.defectClass)
  const symbol = str(s?.symbol) ?? findingId?.split('-')[0]
  if (!symbol) return { ...fallback, note: 'request names no finding' }
  return {
    symbol: symbol.toUpperCase(),
    ...(findingId ? { findingId } : {}),
    ...(defectClass ? { defectClass } : {}),
    chosenBy: 'requester',
    note: 'scope named in the request document',
  }
}

// ---------------------------------------------------------------------------------------------
// Reading documents a SUBJECT controls: agent cards and request documents.
// ---------------------------------------------------------------------------------------------

/**
 * Public IPFS gateways, tried in order. The gateway is trusted for content; which one answered is
 * recorded in the sidecar. More than one because a single gateway rate-limits: ipfs.io and
 * dweb.link both answered 429 for a card Pinata's gateway served, from the same machine, minutes apart.
 */
export const IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'] as const

/** An agent card cap. Cards are a few KB; anything near this is not a card. */
export const DOCUMENT_MAX_BYTES = 64 * 1024

export class DocumentReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentReadError'
  }
}

export type DocumentSource = { kind: 'urls'; urls: string[] } | { kind: 'inline'; bytes: Uint8Array }

/**
 * Where a tokenURI or requestURI can be read from.
 *
 * `fetch(agentURI)` had no scheme handling, so an ipfs:// card — how OpenServ's own registerOnChain
 * registers every agent — failed with "unknown scheme", and an empty tokenURI threw "Invalid URL":
 * the likeliest requesters got a stack trace instead of a deliberate refusal.
 */
export function resolveDocumentURI(uri: string): DocumentSource {
  const u = uri.trim()
  if (!u) {
    throw new DocumentReadError(
      'the tokenURI is empty: the subject has registered no agent card, so there is no declared mandate to read',
    )
  }
  if (u.startsWith('ipfs://')) {
    const path = u.slice('ipfs://'.length).replace(/^ipfs\//, '')
    if (!path) throw new DocumentReadError(`ipfs URI with no CID: ${u}`)
    return { kind: 'urls', urls: IPFS_GATEWAYS.map((g) => g + path) }
  }
  if (u.startsWith('data:')) {
    const comma = u.indexOf(',')
    if (comma < 0) throw new DocumentReadError('malformed data: URI')
    const meta = u.slice(5, comma)
    const payload = u.slice(comma + 1)
    try {
      const bytes = meta.endsWith(';base64')
        ? new Uint8Array(Buffer.from(payload, 'base64'))
        : new TextEncoder().encode(decodeURIComponent(payload))
      return { kind: 'inline', bytes }
    } catch {
      throw new DocumentReadError('malformed data: URI')
    }
  }
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    throw new DocumentReadError(`not a URI: ${u.slice(0, 80)}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new DocumentReadError(`${parsed.protocol} is not read: only https, ipfs and data URIs are`)
  }
  return { kind: 'urls', urls: [parsed.toString()] }
}

/** Loopback, private, link-local and carrier-NAT ranges, plus local-only names. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(h)) return true
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number]
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (isIP(h) === 6) {
    if (h === '::1' || h === '::') return true
    if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7))
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(h)
  }
  return false
}

export interface FetchBoundedOptions {
  maxBytes?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Resolve a hostname to its addresses. Injected in tests; DNS in production. */
  lookup?: (hostname: string) => Promise<string[]>
}

async function defaultLookup(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true })).map((r) => r.address)
}

/**
 * Fetch a document the subject controls, from this machine, without trusting it.
 *
 * The card fetch runs on the operator's laptop against a URL the subject chose, and it had no size
 * cap, followed redirects anywhere and would read http://127.0.0.1. Now: https only, every hop's
 * host resolved and refused if private, at most 3 redirects, and the body cut off at maxBytes.
 */
export async function fetchBounded(url: string, o: FetchBoundedOptions = {}): Promise<Uint8Array> {
  const maxBytes = o.maxBytes ?? DOCUMENT_MAX_BYTES
  const fetchImpl = o.fetchImpl ?? fetch
  const lookup = o.lookup ?? defaultLookup
  let current = url
  for (let hop = 0; hop <= 3; hop++) {
    const u = new URL(current)
    if (u.protocol !== 'https:') throw new DocumentReadError(`refusing ${u.protocol} at ${current}`)
    const addresses = isIP(u.hostname.replace(/^\[|\]$/g, '')) ? [u.hostname] : await lookup(u.hostname)
    if (isPrivateHost(u.hostname) || addresses.some(isPrivateHost)) {
      throw new DocumentReadError(`refusing a private or loopback host: ${u.hostname}`)
    }
    const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 8000) })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new DocumentReadError(`HTTP ${res.status} with no Location from ${current}`)
      current = new URL(location, current).toString()
      continue
    }
    if (!res.ok) throw new DocumentReadError(`HTTP ${res.status} from ${current}`)
    return readCapped(res, maxBytes, current)
  }
  throw new DocumentReadError(`more than 3 redirects from ${url}`)
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const tooBig = () => new DocumentReadError(`${url} is larger than ${maxBytes} bytes`)
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw tooBig()
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer())
    if (b.length > maxBytes) throw tooBig()
    return b
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw tooBig()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** Read a tokenURI / requestURI through every source it resolves to. Throws DocumentReadError. */
export async function readDocument(
  uri: string,
  o: FetchBoundedOptions = {},
): Promise<{ bytes: Uint8Array; from: string }> {
  const src = resolveDocumentURI(uri)
  if (src.kind === 'inline') {
    if (src.bytes.length > (o.maxBytes ?? DOCUMENT_MAX_BYTES)) throw new DocumentReadError('data: URI is too large')
    return { bytes: src.bytes, from: 'data: URI' }
  }
  const failures: string[] = []
  for (const url of src.urls) {
    try {
      return { bytes: await fetchBounded(url, o), from: url }
    } catch (e) {
      failures.push((e as Error).message)
    }
  }
  throw new DocumentReadError(`could not read ${uri}: ${failures.join('; ')}`)
}

/** Declared mandate bounds. Below the floor there is nothing to adjudicate; above the cap, refuse rather than truncate a subject's declaration. */
export const MANDATE_MIN_CHARS = 40
export const MANDATE_MAX_CHARS = 4000

/** An agent card's name and description, the only fields that become the mandate. Pure. */
export function mandateFromCard(bytes: Uint8Array): { name: string | null; mandate: string } {
  let card: unknown
  try {
    card = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new DocumentReadError('the agent card is not JSON')
  }
  const c = (card ?? {}) as { name?: unknown; description?: unknown }
  const name = typeof c.name === 'string' ? c.name : null
  const description = typeof c.description === 'string' ? c.description : null
  return { name, mandate: [name, description].filter(Boolean).join('\n\n') }
}

// ---------------------------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------------------------

const ZERO_HASH = `0x${'0'.repeat(64)}` as const
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

export interface ValidationRequestStatus {
  requestHash: `0x${string}`
  validator: `0x${string}`
  agentId: bigint
  answered: boolean
  tag: string
  response: number
  responseHash: `0x${string}`
  /** A TIMESTAMP, of the request until a response is written, then of the latest response. */
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

type StatusTuple = readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint]

function toStatus(requestHash: `0x${string}`, s: StatusTuple): ValidationRequestStatus {
  return {
    requestHash,
    validator: s[0],
    agentId: s[1],
    response: s[2],
    responseHash: s[3],
    tag: s[4],
    lastUpdate: s[5],
    answered: isAnswered(s[3]),
  }
}

export async function validationStatus(
  requestHash: `0x${string}`,
  client = publicBase(),
): Promise<ValidationRequestStatus> {
  const status = (await client.readContract({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    functionName: 'getValidationStatus',
    args: [requestHash],
  })) as StatusTuple
  return toStatus(requestHash, status)
}

/**
 * One request's status, or null when the registry has no such request.
 *
 * getValidationStatus reverts on an unknown hash rather than returning zeroes, and a zero
 * validator is treated the same way in case a deployment answers instead of reverting.
 */
export async function requestStatus(
  requestHash: `0x${string}`,
  client = publicBase(),
): Promise<ValidationRequestStatus | null> {
  try {
    const s = await validationStatus(requestHash, client)
    return s.validator.toLowerCase() === ZERO_ADDRESS ? null : s
  } catch {
    return null
  }
}

/**
 * Whether an existing request may be reused for (validator, agentId).
 *
 * attest:submit used to "reuse" any request whose validator was non-zero. Its fixed requestHash
 * belonged to frozen 95265's request, validated by the lost key, so every attempt for canonical
 * 95374 would have reverted — 'exists' on the request, 'not validator' on the response.
 */
export function requestReuse(
  status: ValidationRequestStatus | null,
  validator: string,
  agentId: bigint,
): 'new' | 'reuse' | 'collision' {
  if (!status) return 'new'
  return status.validator.toLowerCase() === validator.toLowerCase() && status.agentId === agentId ? 'reuse' : 'collision'
}

/**
 * Requests addressed to us, newest first, at most `limit` of them.
 *
 * getValidatorRequests is an unbounded array, any agent owner can append to it by naming ASSAY as
 * validator, and every entry used to cost one sequential RPC call. The statuses now come back in
 * one multicall, over the newest `limit` hashes only; `total` says how many exist.
 */
export async function validatorRequests(
  validator: `0x${string}`,
  { limit = 50, client = publicBase() }: { limit?: number; client?: ReturnType<typeof publicBase> } = {},
): Promise<{ total: number; statuses: ValidationRequestStatus[] }> {
  const hashes = (await client.readContract({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    functionName: 'getValidatorRequests',
    args: [validator],
  })) as readonly `0x${string}`[]
  const newest = hashes.slice(-limit).reverse()
  if (!newest.length) return { total: hashes.length, statuses: [] }
  const results = await client.multicall({
    allowFailure: true,
    contracts: newest.map((requestHash) => ({
      address: VALIDATION_REGISTRY,
      abi: validationRegistryAbi,
      functionName: 'getValidationStatus' as const,
      args: [requestHash] as const,
    })),
  })
  const statuses: ValidationRequestStatus[] = []
  results.forEach((r, i) => {
    if (r.status === 'success') statuses.push(toStatus(newest[i]!, r.result as StatusTuple))
  })
  return { total: hashes.length, statuses }
}

/** Requests addressed to us that we have not yet answered, among the newest `limit`. */
export async function pendingRequests(
  validator: `0x${string}`,
  opts: { limit?: number } = {},
): Promise<ValidationRequestStatus[]> {
  return (await validatorRequests(validator, opts)).statuses.filter((r) => !r.answered)
}

/** The subset of a viem public client the event lookups need. Narrow so tests can stub it. */
export type EventReader = Pick<ReturnType<typeof publicBase>, 'getBlock' | 'getContractEvents'>

/**
 * The Base block produced at `timestamp`.
 *
 * Base has produced a block every 2 seconds since Bedrock, so the arithmetic lands on it; the
 * read-back corrects any drift instead of trusting that. Needed because the public RPC caps
 * eth_getLogs at a 1,000-block range, so "every log for this requestHash" cannot be asked for.
 */
export async function blockAtTimestamp(timestamp: bigint, client: EventReader): Promise<bigint> {
  const head = await client.getBlock()
  let block = head.number - (head.timestamp - timestamp) / 2n
  for (let i = 0; i < 4; i++) {
    const b = await client.getBlock({ blockNumber: block })
    const drift = timestamp - b.timestamp
    if (drift > -2n && drift < 2n) return block
    block += drift / 2n
  }
  return block
}

/**
 * The registry events for `requestHash` in the block stamped `lastUpdate`, found without a scan.
 *
 * lastUpdate is the request's timestamp until it is answered and the latest response's after, so
 * it locates the request event of a pending request and the latest response of an answered one.
 * ±10 blocks absorbs any drift in the estimate and stays far inside the RPC's range cap.
 */
async function eventWindow(lastUpdate: bigint, client: EventReader) {
  const block = await blockAtTimestamp(lastUpdate, client)
  return { fromBlock: block - 10n, toBlock: block + 10n }
}

/** The ValidationRequest event of a PENDING request: where its requestURI is recorded. */
export async function requestEventAt(requestHash: `0x${string}`, lastUpdate: bigint, client: EventReader = publicBase()) {
  const logs = await client.getContractEvents({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    eventName: 'ValidationRequest',
    args: { requestHash },
    ...(await eventWindow(lastUpdate, client)),
  })
  const log = logs.at(-1)
  return log ? { requestURI: log.args.requestURI ?? '', blockNumber: log.blockNumber } : null
}

/**
 * The LATEST ValidationResponse event of an answered request: the responseURI committed on-chain.
 *
 * verify:attestation used to fetch a URL it built from the agentId, so it checked a location it
 * had chosen rather than the one the validator committed to, and a re-pointed or mistyped
 * responseURI could never have been caught.
 */
export async function responseEventAt(requestHash: `0x${string}`, lastUpdate: bigint, client: EventReader = publicBase()) {
  const logs = await client.getContractEvents({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    eventName: 'ValidationResponse',
    args: { requestHash },
    ...(await eventWindow(lastUpdate, client)),
  })
  const log = logs.at(-1)
  return log
    ? {
        responseURI: log.args.responseURI ?? '',
        responseHash: log.args.responseHash as `0x${string}` | undefined,
        tag: log.args.tag ?? '',
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      }
    : null
}

/**
 * Does the live URL serve these exact bytes? Hashes the raw body, never decoded text.
 */
export async function confirmServed(
  uri: string,
  expectedHash: `0x${string}`,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; servedHash: `0x${string}` | null; status: number }> {
  const res = await fetchImpl(uri, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return { ok: false, servedHash: null, status: res.status }
  const servedHash = hashBytes(new Uint8Array(await res.arrayBuffer()))
  return { ok: servedHash === expectedHash, servedHash, status: res.status }
}

/** What attest:respond's prepare step records, and the only input its submit step reads. */
export interface SolicitedSidecar {
  requestHash: `0x${string}`
  agentId: string
  /** The key that prepared it. Submit refuses under any other. */
  validator: string
  document: string
  responseURI: string
  responseHash: `0x${string}`
  tag: AttestationTag
  score: number
  verdict: Verdict
  findingId: string
  defectClass: string
  scopeChosenBy: 'requester' | 'default'
  inputHash: `0x${string}`
  model: string
  rubricVersion: string
  detectionVersion: string
  sweptAtBlock: string
  /** The full adjudication as returned, including meta. */
  adjudication: unknown
  /** The exact user message sent, so inputHash can be recomputed from this file alone. */
  userMessage: string
  /** Where the card was actually read: the URL, or the IPFS gateway that answered. */
  cardSource: string
  droppedEvidence: string[]
  preparedAt: string
  submitted?: { responseTx: `0x${string}`; status: string }
}

export interface SubmitDeps {
  /** Resolve the sidecar and document paths against this directory. */
  root?: string
  fetchImpl?: typeof fetch
  readStatus?: (requestHash: `0x${string}`) => Promise<ValidationRequestStatus | null>
  sign: (args: {
    requestHash: `0x${string}`
    response: number
    responseURI: string
    responseHash: `0x${string}`
    tag: AttestationTag
  }) => Promise<`0x${string}`>
}

/**
 * STEP 2 of the solicited flow: sign what STEP 1 wrote, after checking it is what is served.
 *
 * WHY THIS IS A SEPARATE STEP. attest:respond used to sweep and call SERV on the signing run too,
 * then compare the served copy against a document it had just rebuilt. A new block and a
 * stochastic model meant the two never matched, so "--dry, deploy, re-run" failed forever and
 * spent a SERV call each time; and had it matched, the verdict signed would not have been the one
 * reviewed. This function reads bytes and a sidecar. It has no path to the sweep or the model:
 * this module imports neither.
 */
export async function submitSolicitedResponse(
  requestHash: `0x${string}`,
  validator: string,
  deps: SubmitDeps,
): Promise<{ ok: true; tx: `0x${string}`; sidecar: SolicitedSidecar } | { ok: false; reason: string }> {
  const root = deps.root ?? '.'
  const sidecarPath = join(root, respondSidecarPath(requestHash))
  let sidecar: SolicitedSidecar
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as SolicitedSidecar
  } catch {
    return { ok: false, reason: `no prepared response at ${sidecarPath}: run the prepare step first` }
  }
  if (sidecar.requestHash.toLowerCase() !== requestHash.toLowerCase()) {
    return { ok: false, reason: 'the sidecar is for a different request' }
  }
  if (sidecar.validator.toLowerCase() !== validator.toLowerCase()) {
    return { ok: false, reason: `prepared under ${sidecar.validator}, not ${validator}` }
  }
  if (sidecar.submitted) return { ok: false, reason: `already submitted in ${sidecar.submitted.responseTx}` }

  const status = await (deps.readStatus ?? requestStatus)(requestHash)
  if (!status) return { ok: false, reason: 'the registry has no such request' }
  if (status.validator.toLowerCase() !== validator.toLowerCase()) {
    return { ok: false, reason: `the request names validator ${status.validator}, not ${validator}` }
  }
  if (status.agentId.toString() !== sidecar.agentId) {
    return { ok: false, reason: `the request is for agent ${status.agentId}, the sidecar for ${sidecar.agentId}` }
  }
  if (status.answered) return { ok: false, reason: `already answered: tag=${status.tag} score=${status.response}` }

  const bytes = new Uint8Array(readFileSync(join(root, sidecar.document)))
  const onDisk = hashBytes(bytes)
  if (onDisk !== sidecar.responseHash) {
    return { ok: false, reason: `the document changed since prepare\n  prepared ${sidecar.responseHash}\n  disk     ${onDisk}` }
  }
  // The tag comes from the document that will be anchored, and must agree with the sidecar.
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as { tag?: string; score?: number }
  if (doc.tag !== sidecar.tag || doc.score !== scoreFor(sidecar.tag)) {
    return { ok: false, reason: `the document says ${doc.tag}/${doc.score}, the sidecar ${sidecar.tag}/${sidecar.score}` }
  }

  const served = await confirmServed(sidecar.responseURI, onDisk, deps.fetchImpl)
  if (!served.ok) {
    return {
      ok: false,
      reason: served.servedHash
        ? `MISMATCH: ${sidecar.responseURI} serves ${served.servedHash}, the document is ${onDisk}. Deploy it, then re-run submit.`
        : `${sidecar.responseURI} is not reachable (HTTP ${served.status}). Deploy first.`,
    }
  }

  const tx = await deps.sign({
    requestHash,
    response: scoreFor(sidecar.tag),
    responseURI: sidecar.responseURI,
    responseHash: onDisk,
    tag: sidecar.tag,
  })
  return { ok: true, tx, sidecar }
}
