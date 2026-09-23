import { hashBytes, publicBase, responseEventAt, validationStatus } from '../src/attest/index.js'

/**
 * Independently verify the published attestation, the way a third party would.
 *
 * Reads the on-chain responseHash, reads the responseURI the validator COMMITTED TO from its
 * ValidationResponse event, fetches it, hashes the raw bytes, compares. Uses nothing local — no
 * repo file, no key — so it proves the claim rather than restating it.
 *
 * This exists because the attestation silently drifted once: the on-chain hash committed to bytes
 * that had been overwritten and were never committed, so "anyone can verify" was false for a while
 * and nothing caught it. Now it is in the test suite.
 *
 * Two earlier shortcuts are gone. It fetched a URL it built from the agentId, so it verified a
 * location it chose rather than the one on-chain; and it hashed Response.text(), which strips a
 * UTF-8 BOM, so it could pass bytes a raw-byte verifier would reject.
 *
 *   pnpm verify:attestation [requestHash]    defaults to the self-attestation under 95374
 */
const REQUEST_HASH = '0x8e9f35901bb72c4efb62d6818a14d644c523513d5ba117ed4fc8e9296ff21aeb' as const
/** The earlier self-attestation, under frozen 95265. Still on-chain, still verifiable. */
export const REQUEST_HASH_95265 = '0x18cdff93e8da064a74bc7c32b0895e3ecf55f060f507ca60b341bb16deb18078' as const

export async function verifyAttestation(requestHash: `0x${string}` = REQUEST_HASH) {
  const pub = publicBase()
  const s = await validationStatus(requestHash, pub)
  const event = await responseEventAt(requestHash, s.lastUpdate, pub)
  if (!event) throw new Error(`no ValidationResponse event for ${requestHash} at its lastUpdate`)
  if (event.responseHash?.toLowerCase() !== s.responseHash.toLowerCase()) {
    throw new Error(`the latest ValidationResponse event carries ${event.responseHash}, the registry ${s.responseHash}`)
  }

  const uri = event.responseURI
  const res = await fetch(uri, { cache: 'no-store' })
  if (!res.ok) throw new Error(`responseURI unreachable: HTTP ${res.status}`)
  const servedHash = hashBytes(new Uint8Array(await res.arrayBuffer()))

  return {
    validator: s.validator,
    agentId: s.agentId.toString(),
    response: s.response,
    tag: s.tag,
    responseHash: s.responseHash,
    servedHash,
    uri,
    responseTx: event.transactionHash,
    matches: servedHash === s.responseHash,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2]
  if (arg && !/^0x[0-9a-fA-F]{64}$/.test(arg)) {
    console.error('usage: pnpm verify:attestation [requestHash]')
    process.exit(1)
  }
  const r = await verifyAttestation(arg as `0x${string}` | undefined)
  console.log(`agent      8453:${r.agentId}`)
  console.log(`validator  ${r.validator}`)
  console.log(`tag/score  ${r.tag} / ${r.response}`)
  console.log(`uri        ${r.uri}  (from tx ${r.responseTx})`)
  console.log(`on-chain   ${r.responseHash}`)
  console.log(`served     ${r.servedHash}`)
  console.log(r.matches ? 'VERIFIES' : 'MISMATCH')
  process.exit(r.matches ? 0 : 1)
}
