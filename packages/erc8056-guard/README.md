# erc8056-guard

**`balanceOf()` is not a share count.** Read Robinhood Chain Stock Tokens correctly, or refuse.

Independent project; not affiliated with, endorsed by, or officially connected with Robinhood
Markets, Inc. or Chainlink Labs. Provided as is; not financial advice.

```bash
npm i erc8056-guard viem
```

ESM only, with TypeScript types. `viem` is a peer dependency: you pass in your own client.

```ts
import { createPublicClient, http, formatUnits } from 'viem'
import { shareEquivalents, RPC_URL } from 'erc8056-guard'

const CRWD = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931'   // CRWD Stock Token, chain 4663, 18 decimals
const holder = '0x…'                                           // the address you are valuing

const client = createPublicClient({ transport: http(RPC_URL) })
const r = await shareEquivalents(client, CRWD, holder)

if (!r.safe) throw new Error(r.reason)    // e.g. "oraclePaused() is true"

formatUnits(r.rawBalance!, 18)            // what balanceOf() says, in tokens: "10" for a 10-token holder
formatUnits(r.shareEquivalents!, 18)      // what they represent: "40" share-equivalents
r.shareEquivalents                        // 40000000000000000000n: a bigint in the token's base units
r.multiplier                              // 4000000000000000000n: uiMultiplier(), 1e18 fixed point
r.blockNumber                             // the one block all three reads were made at
```

## Why

Robinhood Stock Tokens implement [ERC-8056](https://eips.ethereum.org/EIPS/eip-8056): a corporate
action moves `uiMultiplier()`, **not** balances. CRWD's multiplier is `4.0` (read on-chain at block
70115823), so a holder of 10 tokens holds **40 share-equivalents**. Reading the raw balance as
shares understates it by 75%.

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

## API

Every bigint is exact. `shareEquivalents` and `readFeed` never throw: a bad token, feed or RPC
comes back as a refusal with a reason.

| Export | Returns |
|---|---|
| `shareEquivalents(client, token, holder, { blockNumber? })` | `Promise<GuardedReading>`: `shareEquivalents`, `rawBalance` and `multiplier` as `bigint \| null`, plus `blockNumber`, `safe`, `reason`, `checks`. `shareEquivalents` and `rawBalance` are in the token's base units; `multiplier` is 1e18 fixed point (4.0 is `4000000000000000000n`). All three reads are pinned to one block, the latest unless you pass one. |
| `readFeed(client, feed, nowSeconds?, heartbeat = 86400, { blockNumber? })` | `Promise<FeedReading>`: `usable`, `reason`, `price` (a JS `number` in USD, e.g. `181.42`), `ageSeconds`, `blockNumber`. Omit `nowSeconds` to measure age against the block's own timestamp. A round more than 60s in the future is refused. |
| `toShareEquivalents(rawBalance, uiMultiplier)` | `bigint`: `rawBalance * uiMultiplier / 1e18`, same units as `rawBalance`. No RPC. |
| `toTokenUnits(shareEquivalents, uiMultiplier)` | `bigint`: the inverse. Throws on a zero multiplier. |
| `referencesMultiplier(client, address)` | `Promise<{ found, codeSize, isLikelyProxy }>`: whether the bytecode contains the `uiMultiplier()` selector. `false` is not an accusation; see the doc comment. |
| `CHAIN_ID`, `RPC_URL`, `GUARD_ADDRESS`, `ONE`, `DEFAULT_HEARTBEAT_SECONDS`, `FUTURE_TOLERANCE_SECONDS`, `stockTokenAbi`, `aggregatorV3Abi`, `UI_MULTIPLIER_SELECTOR` | Constants. |

## What it does not check

- **That a feed belongs to the token.** `readFeed` prices whatever feed you pass. Pass that token's
  feed.
- **A pending multiplier change.** ERC-8056's `newUIMultiplier()` and `effectiveAt()` are not read.
  A reading is correct for its block; do not cache it across a scheduled corporate action.
- **Late heartbeats.** Staleness is strictly `age > heartbeat`, as on-chain. SGOV's daily updates
  have landed up to 26s past 86,400s, so pass a buffer (for example `86_400 + 600`) if a few
  seconds of lateness should not count as stale.

## On-chain

The same ladder is deployed on Robinhood Chain 4663 as `ERC8056Guard` at
[`0x674f9b0eC3C3643c1f51c0a40D4837932F9c1648`](https://robinhoodchain.blockscout.com/address/0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648)
(exported as `GUARD_ADDRESS`). Ownerless, storage-free and `view`-only, and
[verified as an exact match on Sourcify](https://repo.sourcify.dev/4663/0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648)
against [`contracts/ERC8056Guard.sol`](https://github.com/OoJae/assay/blob/main/contracts/ERC8056Guard.sol).

```solidity
interface IERC8056Guard {
    function shareEquivalents(address token, address holder)
        external view returns (uint256 shares, bool safe, string memory reason);
}

try IERC8056Guard(0x674f9b0eC3C3643c1f51c0a40D4837932F9c1648).shareEquivalents(token, holder)
    returns (uint256 shares, bool safe, string memory reason) {
    require(safe, reason);
    // shares is in the token's base units
} catch {
    revert("guard reverted: token has no code or returned malformed data");
}
```

```bash
cast call 0x674f9b0eC3C3643c1f51c0a40D4837932F9c1648 \
  "shareEquivalents(address,address)(uint256,bool,string)" \
  0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931 <holder> \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
```

**It can revert, despite its NatSpec.** The contract says "Never reverts", and that is wrong for
some inputs. Solidity's `try`/`catch` does not catch a failure to decode the return data, so
`shareEquivalents`, `positionValue` and `feedUsable` revert when the token or feed address has no
code or returns malformed data. `positionValue` and `feedUsable` also revert on a feed that reports
`updatedAt` in the future. The contract is immutable, so the NatSpec cannot be corrected: pass real
Stock Token and feed addresses, and call it inside your own `try`/`catch` as above. Like `readFeed`,
`positionValue` does not check that the feed belongs to the token.

## Related

[ASSAY](https://assay-steel.vercel.app) audits this defect class across the chain and publishes
byte-verified findings. This package is the preventive half; that is the detective half.

MIT.
