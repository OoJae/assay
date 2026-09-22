import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { VALIDATION_REGISTRY, validationRegistryAbi } from '../src/attest/registry.js'
import {
  buildEvidenceDocument,
  hashDocument,
  publicBase,
  scoreFor,
  validatorRequests,
  walletFor,
  type AttestationTag,
} from '../src/attest/index.js'
import { adjudicate, isPlaceholderKey, type Verdict } from '../src/adjudicate/serv.js'
import { sweep } from '../src/sweep/detect.js'
import { METHODOLOGY_VERSION } from '../src/sweep/detect.js'

/**
 * Answer a validation request a THIRD PARTY asked for.
 *
 * This closes the only loop in the project that was broken at its last step. A subject could
 * already call validationRequest() on the ERC-8004 ValidationRegistry naming ASSAY as validator,
 * and `pnpm attest:pending` could already see it — but nothing existed to answer it.
 * attest-submit.ts is hardcoded to ASSAY's own agentId, so ASSAY could only ever grade itself.
 *
 * It is also the ONLY user-reachable path to the SERV adjudicator. Everything in src/adjudicate/
 * was imported exclusively by offline research scripts, which meant the model that decides
 * materiality against a subject's declared mandate could not be invoked by any user, ever.
 *
 * SOLICITED ONLY, and that rule is what makes this defensible. ASSAY never initiates an on-chain
 * statement about a named party; it answers one that party asked for. The unsolicited sweep stays
 * unadjudicated and off-chain, because every gate in the rubric asks "does the declared mandate
 * state X" and an unsolicited subject has supplied no mandate. Inventing one would be a worse
 * integrity defect than leaving the sweep unadjudicated.
 *
 *   pnpm attest:respond <requestHash> [--dry]
 */
dotenv.config({ override: true })

const requestHash = process.argv[2] as `0x${string}` | undefined
const dry = process.argv.includes('--dry')

if (!requestHash || !/^0x[0-9a-fA-F]{64}$/.test(requestHash)) {
  console.error('usage: pnpm attest:respond <requestHash> [--dry]\n')
  console.error('Run `pnpm attest:pending` to list inbound requests.')
  process.exit(1)
}

const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing — run pnpm wallets')
// Checked BEFORE the sweep, not discovered as a 401 after it. The placeholder copied from
// .env.example is truthy, so a bare presence check let it through.
if (isPlaceholderKey(process.env.SERV_API_KEY)) {
  console.error('SERV_API_KEY is missing or still the .env.example placeholder.')
  console.error('The adjudicator is the whole point of this script: a verdict about a named third')
  console.error('party must not be hand-authored, so without it nothing is issued.')
  process.exit(1)
}
const account = privateKeyToAccount(pk)

// --- 1. The request must exist, be addressed to us, and be unanswered ---
const inbound = await validatorRequests(account.address)
const req = inbound.find((r) => r.requestHash.toLowerCase() === requestHash.toLowerCase())
if (!req) {
  console.error(`No request ${requestHash} is addressed to ${account.address}.`)
  console.error('ASSAY only answers verdicts a subject asked for. Nothing to do.')
  process.exit(1)
}
if (req.answered) {
  console.error(`Already answered: tag=${req.tag} score=${req.response}. Refusing to overwrite.`)
  process.exit(1)
}

console.log(`request  ${requestHash}`)
console.log(`subject  agentId ${req.agentId}`)

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
  args: [req.agentId],
})) as string

console.log(`card     ${agentURI}`)
const cardRes = await fetch(agentURI, { signal: AbortSignal.timeout(8000) })
if (!cardRes.ok) {
  console.error(`agent card unreachable (HTTP ${cardRes.status}). Cannot read the declared mandate.`)
  console.error('WITHHELD is the correct outcome, but it must be issued deliberately, not by accident.')
  process.exit(1)
}
const card = (await cardRes.json()) as { name?: string; description?: string }
const declaredMandate = [card.name, card.description].filter(Boolean).join('\n\n')
if (declaredMandate.trim().length < 40) {
  console.error('The agent card carries no usable mandate text. Every adjudication gate asks what')
  console.error('the mandate STATES; with nothing stated there is nothing to adjudicate against.')
  process.exit(1)
}

/**
 * The mandate is authored by the party being graded, so it is hostile input by construction —
 * including permissionless ERC-20 name()/symbol() strings that reach it. serv_prompt_guard is
 * enabled inside adjudicate() for exactly this reason. Disclosed because the text is transmitted
 * to inference-api.openserv.ai under this account's data-collection setting.
 */
console.log(`mandate  ${declaredMandate.length} chars from the subject's own card`)

// --- 3. Sweep, verify, adjudicate ---
console.log('\nsweeping for evidence…')
const r = await sweep({ symbols: ['CRWD', 'NVDA', 'SPY'] })
const finding = r.findings[0]
if (!finding) {
  console.error('No verified finding available to adjudicate against. Refusing to issue a verdict.')
  process.exit(1)
}
console.log(`  ${r.findings.length} verified findings at block ${r.blockNumber}`)

console.log('adjudicating (SERV, kronos + multipath + prompt guard + shadow agent)…')
const a = await adjudicate(finding, declaredMandate)
console.log(`  verdict  ${a.verdict} / ${a.severity}`)
console.log(`  rationale ${a.rationale.slice(0, 160)}…`)

/**
 * Map the adjudicator's vocabulary onto the registry's.
 *
 * These two enums have coexisted since both were written and were never connected: Verdict has
 * BENIGN where AttestationTag has CLEAN. Nothing ever crossed the boundary because nothing ever
 * called the adjudicator from a path that writes on-chain.
 */
const TAG: Record<Verdict, AttestationTag> = {
  BENIGN: 'CLEAN',
  CONTROL_WEAKNESS: 'CONTROL_WEAKNESS',
  MATERIAL_MISSTATEMENT: 'MATERIAL_MISSTATEMENT',
  WITHHELD: 'WITHHELD',
}
const tag = TAG[a.verdict]

// --- 4. The evidence document, deterministic ---
const doc = buildEvidenceDocument({
  agentId: req.agentId.toString(),
  agentName: card.name ?? `agent ${req.agentId}`,
  agentURI,
  validatorAddress: account.address,
  tag,
  methodologyVersion: METHODOLOGY_VERSION,
  assessment: [
    {
      question: 'What did the subject declare it does, and does this finding fall inside it?',
      finding: a.rationale,
      source: agentURI,
    },
    ...a.binding_evidence.map((b, i) => ({
      question: `Binding evidence ${i + 1}`,
      finding: b,
      source: `block ${r.blockNumber} on Robinhood Chain 4663`,
    })),
  ],
  corpus: {
    sweptAtBlock: r.blockNumber,
    assetsScanned: r.assetsScanned,
    findingsPublished: r.findings.length,
    citationsChecked: r.findings.reduce((n, f) => n + f.verification.checked, 0),
    citationsReproduced: r.findings.reduce((n, f) => n + f.verification.reproduced, 0),
    findingsWithheld: r.rejected.length,
  },
  limitations: [
    'SOLICITED: this verdict was requested by the subject. It is not an unsolicited rating.',
    `Adjudicated by SERV Reasoning (${'gpt-5.6-luna-serv-kronos-multipath'}) against the mandate the subject declared in its own agent card.`,
    'The mandate text is authored by the party being graded and was treated as hostile input; serv_prompt_guard was enabled.',
    ...(a.withheld_reason ? [`WITHHELD: ${a.withheld_reason}`] : []),
  ],
  issuedAt: r.observedAt,
})

const serialised = JSON.stringify(doc, null, 2)
const responseHash = hashDocument(serialised)
mkdirSync('web/public/attestations', { recursive: true })
const filename = `web/public/attestations/${req.agentId}.json`
writeFileSync(filename, serialised)

console.log(`\nwrote        ${filename}`)
console.log(`responseHash ${responseHash}`)
console.log(`tag / score  ${tag} / ${scoreFor(tag)}`)

if (dry) {
  console.log('\n--dry: nothing submitted. Deploy the document, then re-run without --dry.')
  process.exit(0)
}

// --- 5. The published bytes must match before anything is signed ---
const responseURI = `https://assay-steel.vercel.app/attestations/${req.agentId}.json`
const served = await fetch(responseURI, { cache: 'no-store' })
if (!served.ok) {
  console.error(`\n${responseURI} is not reachable (HTTP ${served.status}). Deploy first.`)
  process.exit(1)
}
if (hashDocument(await served.text()) !== responseHash) {
  console.error('\nMISMATCH — refusing to attest. Deploy the document above, then re-run.')
  process.exit(1)
}
console.log('published bytes match — proceeding\n')

const wallet = walletFor(pk)
const tx = await wallet.writeContract({
  address: VALIDATION_REGISTRY,
  abi: validationRegistryAbi,
  functionName: 'validationResponse',
  args: [requestHash, scoreFor(tag), responseURI, responseHash, tag],
})
const rc = await pub.waitForTransactionReceipt({ hash: tx })
console.log(`  ${rc.status} https://basescan.org/tx/${tx}`)

writeFileSync(
  `data/attestation-${req.agentId}.json`,
  JSON.stringify({ agentId: req.agentId.toString(), requestHash, tag, score: scoreFor(tag), responseURI, responseHash, responseTx: tx, verdict: a.verdict }, null, 2),
)
console.log(`\nrecorded in data/attestation-${req.agentId}.json`)
