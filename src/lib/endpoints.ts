/**
 * The two paid endpoints, in one place.
 *
 * Each is an OpenServ x402 trigger (USDC on Base, paid to 0x6328…7911) plus the human paywall page
 * OpenServ hosts for it. Free surfaces point here instead of giving the paid answer away. An unpaid
 * POST must carry the SDK body shape below, or OpenServ holds the connection for ~90s instead of
 * answering 402.
 *
 * Every address in the example bodies is a placeholder. The true_position example used to carry a
 * real holder, which was the v4 PoolManager: one of the contracts the old snapshot named, and a
 * pool manager, which nothing public names. It reached the agent card from here.
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
