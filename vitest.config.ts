import { defineConfig } from 'vitest/config'

/**
 * Two suites, split by whether they need the network.
 *
 * `pnpm test:offline` is the CI gate: pure logic, no RPC, no HTTP, no chain. It covers the
 * refusal matrix for the paid primitive, the rate limiter and its XFF handling, the attestation
 * document builder, and the market-closure classifier — which is most of what can silently go
 * wrong, and all of what a fork or a CI runner can check without credentials or a live chain.
 *
 * The live suite is kept and still runs by default, because the byte-verification guarantee is
 * only meaningfully tested against real chain state and the attestation check is only meaningful
 * against the deployed document. But a suite that cannot run without a network is a suite that
 * gets skipped, so the offline half stands alone.
 */
/**
 * Scratch files, excluded so they can never silently join the suite.
 *
 * Adversarial review agents write throwaway reproductions into test/ while they work. One landed
 * mid-run, referenced a scratch copy of a module that no longer existed, and turned a green suite
 * red for reasons that had nothing to do with the code. Anything named zz-* or *.scratch.* is
 * working material, not a gate.
 */
const SCRATCH = ['test/zz-*.test.ts', '**/*.scratch.test.ts']

const LIVE = [
  'test/verify.test.ts', // byte comparison against live Robinhood Chain state
  'test/retention.test.ts', // RPC pruning behaviour, inherently live
  'test/attestation.test.ts', // reads Base mainnet + fetches the deployed document
]

export default defineConfig({
  test: {
    // 60s: the live tests do real sweeps against a ~100ms-block chain.
    testTimeout: 60_000,
    exclude: [
      '**/node_modules/**',
      ...SCRATCH,
      ...(process.env.ASSAY_OFFLINE_ONLY ? LIVE : []),
    ],
  },
})
