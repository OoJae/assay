import { describe, it, expect } from 'vitest'
import { verifyAttestation, REQUEST_HASH_95265 } from '../scripts/verify-attestation.js'

describe('the published attestation', () => {
  it('on-chain responseHash equals the hash of the raw bytes served at the on-chain responseURI', async () => {
    // The regression: the on-chain hash once committed to bytes that had been overwritten by a
    // --dry run and never committed anywhere, so the README's "anyone can verify" was false and
    // nothing caught it. This checks the live claim, using no local file.
    const r = await verifyAttestation(REQUEST_HASH_95265)
    expect(r.matches).toBe(true)
    expect(r.validator.toLowerCase()).toBe('0x0c3a19bea92480a978f2a358e8e1e87b9dad14b5')
    expect(r.tag).toBe('CLEAN')
    // Read from the ValidationResponse event, not built from the agentId.
    expect(r.uri).toBe('https://assay-steel.vercel.app/attestations/95265.json')
    expect(r.responseTx).toBe('0xc3809107f422400f8a8324a4c1f5937fbeca3e3c181fbce6bf32da5a9441f669')
  }, 60_000)

  it('the self-attestation under canonical 95374 verifies the same way', async () => {
    const r = await verifyAttestation()
    expect(r.matches).toBe(true)
    expect(r.validator.toLowerCase()).toBe('0x6328f2fe483922721d94b33ee99e9938da3b7911')
    expect(r.tag).toBe('CLEAN')
    expect(r.uri).toBe('https://assay-steel.vercel.app/attestations/95374/0x8e9f35901bb72c4efb62d6818a14d644c523513d5ba117ed4fc8e9296ff21aeb.json')
    expect(r.responseTx).toBe('0x885d978810fbfccace75db1116897791483624c6ac68573fce96ef7a4dcaf1ee')
  }, 60_000)
})
