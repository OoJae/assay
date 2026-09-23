/**
 * The two paid endpoints, as the wall shows them.
 *
 * A copy of src/lib/endpoints.ts, because web/ is a separate Vercel build that uploads only this
 * directory. test/wall-data.test.ts fails if the triggers, paywalls or prices drift from the
 * source. The example bodies use placeholders for every address, so no page of the wall suggests a
 * particular holder or contract; the shape is what a buyer needs, and an unpaid POST without it is
 * held for ~90s by OpenServ instead of answered with a 402.
 */
export const PAY_TO = '0x6328f2fE483922721D94b33eE99e9938Da3b7911'

export const PAID_ENDPOINTS = {
  truePosition: {
    capability: 'assay_true_position',
    priceUsd: 0.01,
    trigger: 'https://api.openserv.ai/webhooks/x402/trigger/006ecd4add4a459d8ae92362869a42a6',
    paywall: 'https://platform.openserv.ai/workspace/paywall/006ecd4add4a459d8ae92362869a42a6',
    exampleBody: {
      buyerAddress: '0xYourBuyerAddress',
      payload: { symbol: 'NVDA', holder: '0xHolderAddress' },
    },
  },
  checkContract: {
    capability: 'assay_check_contract',
    priceUsd: 0.25,
    trigger: 'https://api.openserv.ai/webhooks/x402/trigger/a1bb2a3946d1411eb945200d43ebc740',
    paywall: 'https://platform.openserv.ai/workspace/paywall/a1bb2a3946d1411eb945200d43ebc740',
    exampleBody: {
      buyerAddress: '0xYourBuyerAddress',
      payload: { address: '0xContractToAudit' },
    },
  },
} as const

/** The copy-paste request that shows the 402 challenge. Five lines, nothing is paid. */
export function curlFor(e: { trigger: string; exampleBody: unknown }): string {
  return [
    'curl -m 20 -i -X POST \\',
    `  ${e.trigger} \\`,
    "  -H 'content-type: application/json' \\",
    `  -d '${JSON.stringify(e.exampleBody)}'`,
    '# -> HTTP 402 and the x402 payment terms (USDC on Base). Nothing is charged.',
  ].join('\n')
}
