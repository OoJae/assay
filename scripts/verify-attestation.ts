import { createPublicClient, http, keccak256, toHex } from 'viem'
import { base } from 'viem/chains'
import { VALIDATION_REGISTRY, validationRegistryAbi } from '../src/attest/registry.js'

/**
 * Independently verify the published attestation, the way a third party would.
 *
 * Reads the on-chain responseHash, fetches the live responseURI, hashes those bytes, compares.
 * Uses nothing local — no repo file, no key — so it proves the claim rather than restating it.
 *
 * This exists because the attestation silently drifted once: the on-chain hash committed to bytes
 * that had been overwritten and were never committed, so "anyone can verify" was false for a while
 * and nothing caught it. Now it is in the test suite.
 */
const REQUEST_HASH = '0x18cdff93e8da064a74bc7c32b0895e3ecf55f060f507ca60b341bb16deb18078' as const

export async function verifyAttestation() {
  const pub = createPublicClient({ chain: base, transport: http() })
  const s = (await pub.readContract({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    functionName: 'getValidationStatus',
    args: [REQUEST_HASH],
  })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint]

  const [validator, agentId, response, responseHash, tag] = s
  const uri = `https://assay-steel.vercel.app/attestations/${agentId}.json`
  const res = await fetch(uri, { cache: 'no-store' })
  if (!res.ok) throw new Error(`responseURI unreachable: HTTP ${res.status}`)
  const servedHash = keccak256(toHex(await res.text()))

  return { validator, agentId: agentId.toString(), response, tag, responseHash, servedHash, uri, matches: servedHash === responseHash }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await verifyAttestation()
  console.log(`agent      8453:${r.agentId}`)
  console.log(`validator  ${r.validator}`)
  console.log(`tag/score  ${r.tag} / ${r.response}`)
  console.log(`on-chain   ${r.responseHash}`)
  console.log(`served     ${r.servedHash}`)
  console.log(r.matches ? 'VERIFIES' : 'MISMATCH')
  process.exit(r.matches ? 0 : 1)
}
