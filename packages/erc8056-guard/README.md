# erc8056-guard

**`balanceOf()` is not a share count.** Read Robinhood Chain Stock Tokens correctly, or refuse.

```bash
npm i erc8056-guard viem
```

```ts
import { createPublicClient, http } from 'viem'
import { shareEquivalents, RPC_URL } from 'erc8056-guard'

const client = createPublicClient({ transport: http(RPC_URL) })
const r = await shareEquivalents(client, CRWD, holder)

if (!r.safe) throw new Error(r.reason)   // e.g. "oraclePaused() is true"
r.shareEquivalents   // 52.1 shares, not the 13.0 tokens balanceOf() returns
```

## Why

Robinhood Stock Tokens implement [ERC-8056](https://eips.ethereum.org/EIPS/eip-8056): a corporate
action moves `uiMultiplier()`, **not** balances. CRWD's multiplier is `4.0`, so a holder with
13.0262 tokens holds **52.1046 share-equivalents**. Reading the raw balance as shares understates
it by 75%.

Two further traps this handles:

- **The Chainlink feed is already multiplier-adjusted.** It returns a *token* price. Applying the
  multiplier to it again double-counts the corporate action — Robinhood's own docs warn about this.
  `readFeed` returns the price unmodified.
- **A check that did not complete is not a check that passed.** If `oraclePaused()` cannot be read,
  this refuses rather than assuming `false`.

## The refusal is the point

`safe: false` with a reason beats a plausible-looking wrong number. Every reading also returns
`checks`, where `false` means **unknown, not fine**:

```ts
{ balanceRead: true, multiplierRead: true, multiplierSane: true, pauseChecked: false, notPaused: false }
```

## On-chain

The same ladder is deployed on Robinhood Chain 4663 as `ERC8056Guard` — ownerless, storage-free and
`view`-only, so a Solidity integrator gets the correction in one external call. See
[the ASSAY repo](https://github.com/OoJae/assay).

## Related

[ASSAY](https://assay-steel.vercel.app) audits this defect class across the chain and publishes
byte-verified findings. This package is the preventive half; that is the detective half.

MIT.
