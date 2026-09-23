import 'dotenv/config'
import * as dotenv from 'dotenv'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { VALIDATION_REGISTRY, validationRegistryAbi } from '../src/attest/registry.js'
import {
  DEFAULT_SOLICITED_SCOPE,
  DocumentReadError,
  MANDATE_MAX_CHARS,
  MANDATE_MIN_CHARS,
  attestationPaths,
  buildSolicitedDocument,
  checkPublishable,
  hashBytes,
  hashDocument,
  mandateFromCard,
  publicBase,
  readDocument,
  requestEventAt,
  requestStatus,
  resolveScope,
  respondSidecarPath,
  scoreFor,
  submitSolicitedResponse,
  tagForVerdict,
  walletFor,
  type SolicitedSidecar,
} from '../src/attest/index.js'
import { isNamedIntegrator } from '../src/lib/redact.js'

/**
 * Answer a validation request a THIRD PARTY asked for, in two steps.
 *
 *   pnpm attest:respond prepare <requestHash>   sweep, adjudicate, check, write the document. No signing.
 *   (deploy the wall, so the document is live)
 *   pnpm attest:respond submit  <requestHash>   hash the deployed bytes, confirm the live URL, sign.
 *
 * WHY TWO STEPS. This used to be one script that swept and called SERV on every run, including the
 * run that signed, and then compared the deployed copy against a document it had just rebuilt. A
 * new block and a stochastic model meant they never matched, so "--dry, deploy, re-run" could not
 * finish and spent a SERV call per attempt — the single-process regenerate-and-sign pattern that
 * attest-build.ts records removing from the self path. Submit now lives in
 * src/attest/index.ts#submitSolicitedResponse, and that module cannot reach the sweep or the model.
 *
 * SOLICITED ONLY, and that rule is what makes this defensible. ASSAY never initiates an on-chain
 * statement about a named party; it answers one that party asked for. The unsolicited sweep stays
 * unadjudicated and off-chain, because every gate in the rubric asks "does the declared mandate
 * state X" and an unsolicited subject has supplied no mandate.
 *
 * It is also the ONLY user-reachable path to the SERV adjudicator.
 */
dotenv.config({ override: true })

const [mode, requestHash] = process.argv.slice(2) as [string | undefined, `0x${string}` | undefined]

if (process.argv.includes('--dry')) {
  console.error('--dry is gone: `prepare` never signs, and `submit` never rebuilds. See the usage below.\n')
}
if ((mode !== 'prepare' && mode !== 'submit') || !requestHash || !/^0x[0-9a-fA-F]{64}$/.test(requestHash)) {
  console.error('usage: pnpm attest:respond prepare <requestHash>')
  console.error('       pnpm attest:respond submit  <requestHash>\n')
  console.error('Run `pnpm attest:pending` to list inbound requests.')
  process.exit(1)
}

const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing — run pnpm wallets')
const account = privateKeyToAccount(pk)

function refuse(...lines: string[]): never {
  for (const l of lines) console.error(l)
  process.exit(1)
}

// ------------------------------------------------------------------------------------------------
// SUBMIT. Reads the sidecar and the deployed bytes; nothing else.
// ------------------------------------------------------------------------------------------------
if (mode === 'submit') {
  const pub = publicBase()
  const out = await submitSolicitedResponse(requestHash, account.address, {
    sign: async (a) => {
      console.log(`signing    ${a.tag} / ${a.response}`)
      console.log(`responseURI ${a.responseURI}`)
      console.log(`responseHash ${a.responseHash}`)
      const tx = await walletFor(pk).writeContract({
        address: VALIDATION_REGISTRY,
        abi: validationRegistryAbi,
        functionName: 'validationResponse',
        args: [a.requestHash, a.response, a.responseURI, a.responseHash, a.tag],
      })
      const rc = await pub.waitForTransactionReceipt({ hash: tx })
      console.log(`  ${rc.status} https://basescan.org/tx/${tx}`)
      if (rc.status !== 'success') throw new Error(`validationResponse reverted in ${tx}`)
      return tx
    },
  })
  if (!out.ok) refuse(`\nrefusing to attest: ${out.reason}`)
  const sidecarPath = respondSidecarPath(requestHash)
  writeFileSync(
    sidecarPath,
    JSON.stringify({ ...out.sidecar, submitted: { responseTx: out.tx, status: 'success' } } satisfies SolicitedSidecar, null, 2),
  )
  console.log(`\nrecorded in ${sidecarPath}`)
  process.exit(0)
}

// ------------------------------------------------------------------------------------------------
// PREPARE. The only step that sweeps or calls SERV, loaded here so submit never imports either.
// ------------------------------------------------------------------------------------------------
const { adjudicate, buildUserMessage, isPlaceholderKey, AdjudicatorError } = await import('../src/adjudicate/serv.js')
const { METHODOLOGY_SYSTEM_PROMPT, METHODOLOGY_VERSION: RUBRIC_VERSION } = await import('../src/adjudicate/methodology.js')
const { sweep } = await import('../src/sweep/detect.js')

// Checked BEFORE the sweep, not discovered as a 401 after it. The placeholder copied from
// .env.example is truthy, so a bare presence check let it through.
if (isPlaceholderKey(process.env.SERV_API_KEY)) {
  refuse(
    'SERV_API_KEY is missing or still the .env.example placeholder.',
    'The adjudicator is the whole point of this script: a verdict about a named third',
    'party must not be hand-authored, so without it nothing is issued.',
  )
}

/**
 * The validator identity comes from the canonical record, not from the request. The old document
 * put the SUBJECT's agentId in `validator.agentId`.
 */
const identity = JSON.parse(readFileSync('data/erc8004.json', 'utf8')) as { agentId: string; owner: string }
if (identity.owner.toLowerCase() !== account.address.toLowerCase()) {
  refuse(`this key (${account.address}) does not own canonical identity ${identity.agentId} (${identity.owner}).`)
}

// --- 1. The request must exist, be addressed to us, and be unanswered — read directly, no scan ---
const status = await requestStatus(requestHash)
if (!status) refuse(`No request ${requestHash} exists in the ValidationRegistry.`)
if (status.validator.toLowerCase() !== account.address.toLowerCase()) {
  refuse(`Request ${requestHash} names validator ${status.validator}, not ${account.address}.`, 'ASSAY only answers verdicts a subject asked it for.')
}
if (status.answered) refuse(`Already answered: tag=${status.tag} score=${status.response}. Refusing to overwrite.`)
const agentId = status.agentId.toString()
if (agentId === identity.agentId) refuse('This request is ASSAY asking about itself: that is the self path (attest:build, attest:submit).')

console.log(`request  ${requestHash}`)
console.log(`subject  agentId ${agentId}`)

/**
 * NEVER OVERWRITTEN. Once deployed these bytes may be what a signature commits to; a second prepare
 * would replace them. If it was never deployed and never submitted, deleting both by hand is safe.
 */
const paths = attestationPaths(agentId, requestHash)
const sidecarPath = respondSidecarPath(requestHash)
for (const p of [paths.document, sidecarPath]) {
  if (existsSync(p)) refuse(`${p} already exists: this request was prepared. Run submit, or delete it by hand if it was never deployed.`)
}

// --- 2. The subject's own declared mandate, from its ERC-8004 agent card ---
const pub = publicBase()
const identityAbi = [
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const
const registry = (await pub.readContract({
  address: VALIDATION_REGISTRY,
  abi: validationRegistryAbi,
  functionName: 'getIdentityRegistry',
})) as `0x${string}`
const agentURI = (await pub.readContract({
  address: registry,
  abi: identityAbi,
  functionName: 'tokenURI',
  args: [status.agentId],
})) as string

console.log(`card     ${agentURI || '(empty tokenURI)'}`)
let card: { bytes: Uint8Array; from: string }
let cardName: string | null
let declaredMandate: string
try {
  card = await readDocument(agentURI)
  ;({ name: cardName, mandate: declaredMandate } = mandateFromCard(card.bytes))
} catch (e) {
  if (!(e instanceof DocumentReadError)) throw e
  refuse(
    `agent card unreadable: ${e.message}`,
    'Without it there is no declared mandate. WITHHELD would be the correct outcome, but it must be',
    'issued deliberately, not by accident, so nothing is issued.',
  )
}
if (card.from !== agentURI) console.log(`         read via ${card.from}`)
if (declaredMandate.trim().length < MANDATE_MIN_CHARS) {
  refuse(
    'The agent card carries no usable mandate text. Every adjudication gate asks what',
    'the mandate STATES; with nothing stated there is nothing to adjudicate against.',
  )
}
if (declaredMandate.length > MANDATE_MAX_CHARS) {
  refuse(`The mandate is ${declaredMandate.length} chars; ASSAY adjudicates at most ${MANDATE_MAX_CHARS} and will not truncate a subject's declaration.`)
}

/**
 * The mandate is authored by the party being graded, so it is hostile input by construction —
 * including permissionless ERC-20 name()/symbol() strings that reach it. serv_prompt_guard is
 * enabled inside adjudicate() for exactly this reason. Disclosed because the text is transmitted
 * to inference-api.openserv.ai under this account's data-collection setting.
 */
console.log(`mandate  ${declaredMandate.length} chars from the subject's own card`)

// --- 3. Which finding decides the verdict: the one the request names, or the documented default ---
let requestURI = ''
let requestBytes: Uint8Array | null = null
try {
  requestURI = (await requestEventAt(requestHash, status.lastUpdate))?.requestURI ?? ''
  if (requestURI) requestBytes = (await readDocument(requestURI)).bytes
} catch (e) {
  console.log(`         request document unreadable (${(e as Error).message.slice(0, 120)})`)
}
const scope = resolveScope(requestBytes, requestHash)
if (scope.defectClass && isNamedIntegrator({ defectClass: scope.defectClass })) {
  refuse(`${scope.defectClass} names a third-party contract and is never adjudicated into a published document.`)
}
const wantClass = scope.defectClass ?? DEFAULT_SOLICITED_SCOPE.defectClass
console.log(`scope    ${scope.findingId ?? `${scope.symbol} ${wantClass}`} (${scope.chosenBy}: ${scope.note})`)

console.log('\nsweeping for evidence…')
// The integrator pass is off: it names third-party contracts, and none of them is in scope here.
const r = await sweep({ symbols: [scope.symbol], integrators: false })
const finding = r.findings.find(
  (f) => !isNamedIntegrator(f) && (scope.findingId ? f.id === scope.findingId : f.defectClass === wantClass),
)
if (!finding) {
  refuse(
    `No verified ${scope.findingId ?? `${scope.symbol} ${wantClass}`} finding at block ${r.blockNumber}.`,
    'Refusing rather than grading the subject on some other finding.',
  )
}
console.log(`  ${finding.id} verified ${finding.verification.reproduced}/${finding.verification.checked} at block ${r.blockNumber}`)

// --- 4. Adjudicate. A refusal, truncation or malformed verdict issues nothing ---
console.log('adjudicating (SERV, kronos + multipath + prompt guard + shadow agent)…')
const userMessage = buildUserMessage(finding, declaredMandate)
let a: Awaited<ReturnType<typeof adjudicate>>
try {
  a = await adjudicate(finding, declaredMandate)
} catch (e) {
  if (e instanceof AdjudicatorError) refuse(`\nno verdict: ${e.message}`, 'Nothing was written. Re-run prepare to ask again.')
  throw e
}
console.log(`  verdict  ${a.verdict} / ${a.severity}  (finish_reason ${a.meta.finishReason})`)

// --- 5. Nothing the model wrote is published until it passes the deterministic checks ---
const check = checkPublishable(
  a,
  {
    claims: finding.evidence.map((e) => e.claim),
    addresses: [...finding.evidence.map((e) => e.contract), ...(finding.subject.match(/0x[0-9a-fA-F]{40}/g) ?? [])],
    text: `${userMessage}\n${METHODOLOGY_SYSTEM_PROMPT}`,
  },
  declaredMandate,
)
if (!check.ok) {
  console.error('\nNOT PUBLISHABLE — nothing was written:')
  for (const p of check.problems) console.error(`  - ${p}`)
  console.error(`\n${JSON.stringify(a, null, 2)}`)
  process.exit(1)
}
if (check.droppedEvidence.length) {
  console.log(`  dropped ${check.droppedEvidence.length} binding_evidence entr(ies) that were not verbatim claims`)
}

const tag = tagForVerdict(a.verdict)
const doc = buildSolicitedDocument({
  requestHash,
  requestURI,
  scope: { findingId: finding.id, defectClass: finding.defectClass, chosenBy: scope.chosenBy },
  subject: {
    agentId,
    name: (cardName ?? `agent ${agentId}`).replace(/[\u0000-\u001f]/g, ' ').slice(0, 120),
    // A data: URI can be the whole card; the hash identifies it without copying it in.
    agentURI: agentURI.startsWith('data:') ? `data: URI (${card.bytes.length} bytes)` : agentURI,
    cardHash: hashBytes(card.bytes),
  },
  validator: { address: account.address, agentId: identity.agentId },
  verdict: a.verdict,
  severity: a.severity,
  rationale: a.rationale,
  bindingEvidence: check.bindingEvidence,
  withheldReason: a.withheld_reason ?? null,
  adjudication: {
    rubricVersion: RUBRIC_VERSION,
    detectionVersion: finding.methodologyVersion,
    model: a.meta.model,
    inputHash: a.meta.inputHash,
    promptGuardTriggered: a.meta.promptGuardTriggered,
    finishReason: a.meta.finishReason,
    sweptAtBlock: r.blockNumber,
  },
  issuedAt: r.observedAt,
})

const serialised = JSON.stringify(doc, null, 2)
const responseHash = hashDocument(serialised)
mkdirSync(dirname(paths.document), { recursive: true })
writeFileSync(paths.document, serialised)

const sidecar: SolicitedSidecar = {
  requestHash,
  agentId,
  validator: account.address,
  document: paths.document,
  responseURI: paths.responseURI,
  responseHash,
  tag,
  score: scoreFor(tag),
  verdict: a.verdict,
  findingId: finding.id,
  defectClass: finding.defectClass,
  scopeChosenBy: scope.chosenBy,
  inputHash: a.meta.inputHash,
  model: a.meta.model,
  rubricVersion: RUBRIC_VERSION,
  detectionVersion: doc.adjudication.detectionVersion,
  sweptAtBlock: r.blockNumber,
  adjudication: a,
  userMessage,
  cardSource: card.from,
  droppedEvidence: check.droppedEvidence,
  preparedAt: r.observedAt,
}
writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2))

console.log(`\nrationale    ${a.rationale}`)
console.log(`\nwrote        ${paths.document}`)
console.log(`             ${sidecarPath}`)
console.log(`responseHash ${responseHash}`)
console.log(`tag / score  ${tag} / ${scoreFor(tag)}`)
console.log(`\nNEXT: review the document, deploy the wall, then run  pnpm attest:respond submit ${requestHash}`)
