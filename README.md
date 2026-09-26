# ASSAY

**Independent valuation-integrity audit for agents moving money on Robinhood Chain (EIP-155 4663).**

[![CI](https://github.com/OoJae/assay/actions/workflows/ci.yml/badge.svg)](https://github.com/OoJae/assay/actions/workflows/ci.yml)

**Try it in a minute.** None of it needs a clone, and only the third needs a wallet.

1. **Check a wallet, free:** <https://assay-steel.vercel.app/wall#check>. Press "Try the burn address"; nothing is signed.
2. **Ask the MCP server:** `claude mcp add --transport http assay https://sonar.my.id/assay-mcp/mcp`, then ask for
   `assay_true_position` on CRWD at `0x000000000000000000000000000000000000dEaD`. It refuses, and says why.
3. **Buy the figures:** the [$0.01 audited position](https://platform.openserv.ai/workspace/paywall/006ecd4add4a459d8ae92362869a42a6)
   and the [$0.25 contract audit](https://platform.openserv.ai/workspace/paywall/a1bb2a3946d1411eb945200d43ebc740),
   over x402 in USDC on Base, via OpenServ ([before you pay](#buy-a-call)).
4. **Start from the landing:** <https://assay-steel.vercel.app>, which leads into the live wall.

> ASSAY is an independent project. It is not affiliated with, endorsed by, or officially connected
> with Robinhood Markets, Inc., its affiliates, or Chainlink Labs. "Robinhood Chain" and "Chainlink"
> are trademarks of their respective owners and are used only to identify the network and data
> sources. ASSAY's output is an automated, informational reading of public blockchain state,
> provided as is and without warranty. It is not investment, financial, legal or tax advice, it is
> not a security audit, and a finding is not a statement that any named party acted wrongly. Verify
> independently before acting.

Built for SERV Hackathon Edition 01, entered in three tracks: *Mainnet & MCP* ("Robinhood Chain /
MCP" on the form), *AgentKit* ("Coinbase AgentKit", for the [action provider](#mcp)) and *Open
Track*. ASSAY is the check an agent acting on Robinhood Chain calls before it values, collateralises
or moves a Stock Token position — as an MCP tool, a free `view` contract on 4663, or a paid x402
call — and the defect it catches is the one an agent hits when it mixes off-chain share prices with
on-chain token balances.

**Where SERV Reasoning runs.** When a subject asks ASSAY for an on-chain ERC-8004 verdict about
itself, SERV Reasoning (`gpt-5.6-luna-serv-kronos-multipath`, with `serv_prompt_guard` and
`serv_shadow_agent`) decides whether a byte-verified finding is **material** against the subject's
own declared mandate, through four ordered gates. It never computes a number. The sweep, the wall
and both paid calls use no model at all. No subject has requested a verdict yet, so every SERV call
so far is a measurement: what we measured, including a null result, is
[below](#what-we-measured-about-serv-and-what-we-found).

**Live wall:** <https://assay-steel.vercel.app/wall> · **Site:** <https://assay-steel.vercel.app> ·
**Repo:** <https://github.com/OoJae/assay>

### On-chain proofs

| | |
|---|---|
| **Settled x402 payment** | [`0x50124847…6b96b`](https://basescan.org/tx/0x50124847a9228521b829e3b47a2b098f5688e57d147e33764232c4c8f686b96b) — 0.01 USDC, buyer `0x09f5…b5B5` → seller `0x0C3A…14B5`, method `transferWithAuthorization`. The buyer spent **zero ETH**: x402 settles via an EIP-3009 signature and a relayer pays the gas. **Four** have settled; this is the one whose reply carries the `checks` block, so the refusal-completeness fix is visible in the thing a buyer actually pays for. The seller in all four is the wallet of frozen identity `95265`, whose key was lost, so those 0.04 USDC cannot be moved; the current payTo is `0x6328…7911`, which the $0.25 settlement below paid. Both buyers are wallets this project created — that is a working rail, not demand, and [/pricing](https://assay-steel.vercel.app/pricing) says so. |
| **ERC-8004 identity** | agent **`8453:95374`** on the IdentityRegistry `0x8004A169…a432` — [mint tx](https://basescan.org/tx/0x019ecbbcfe12f646d977c3a7d778d147d91cac9d6a348cc93a03be6d80e8356f) · [agent card](https://assay-steel.vercel.app/agent-card.json), which the token's URI points at. 8004scan has never parsed that card and shows the agent as a nameless "Agent #95374"; the card itself is served and valid. **`8453:95265` is frozen**: its signing key was lost when a local `.env` was overwritten with a copy of `.env.example`, so it can never be updated again. Everything already published under it stays true and verifiable, and the card discloses both — along with `95266`, an accidental duplicate. |
| **On-chain guard** | [`ERC8056Guard`](https://robinhoodchain.blockscout.com/address/0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648) at `0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648` on Robinhood Chain 4663 — [deploy tx](https://robinhoodchain.blockscout.com/tx/0x30b2029209f10e015bbb5fc7a63106c7f373b3f686ade2c89ee7404f13ca3df6). Free, ownerless, storage-free, `view`-only. **Verified as an exact match on [Sourcify](https://sourcify.dev/#/lookup/0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648)** — creation and runtime bytecode, compiler settings and metadata identical to [`contracts/ERC8056Guard.sol`](contracts/ERC8056Guard.sol). Reproduce it: `cast code 0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648 --rpc-url https://rpc.mainnet.chain.robinhood.com` is byte-identical to `solc --optimize --optimize-runs 200 --bin-runtime contracts/ERC8056Guard.sol` with solc 0.8.35, run from the repo root: the source path is in the metadata hash, so compiling from another directory changes the last bytes. |
| **Contract audit, paid** | [`0xc192e7b9…bc3b2`](https://basescan.org/tx/0xc192e7b94cdd9b1ae4c77e4602f3fad75067b96b19fd24c6d5d2441a4febc3b2) — **0.25 USDC** for an `assay_check_contract`, `transferWithAuthorization`, buyer `0xDA31…d2cB` → `0x6328…7911`. The agent answered with a verdict and its interpretation for the address the buyer supplied; both are withheld here, because nothing public names a holder contract any more ([see the disclosure](#the-other-side-of-the-trade): an earlier commit recorded both). Paid with the SDK's own vendored x402 client and an explicit ceiling equal to the price: `payWorkflow()`'s $0.10 limit is only a default. |
| **On-chain attestation** | agent `95374` rated **CLEAN (100)** by its owner `0x6328…7911` ([request tx](https://basescan.org/tx/0x885769e81d7fb3218cf0e0659e57f1bac48469aabf950222023b14ecb47e7235), [response tx](https://basescan.org/tx/0x885d978810fbfccace75db1116897791483624c6ac68573fce96ef7a4dcaf1ee)) — `getAgentValidations(95374)` returns one entry. The `responseHash` on-chain equals `keccak256` of the exact document served at [`/attestations/95374/0x8e9f3590….json`](https://assay-steel.vercel.app/attestations/95374/0x8e9f35901bb72c4efb62d6818a14d644c523513d5ba117ed4fc8e9296ff21aeb.json); `pnpm verify:attestation` checks that live, and it is in the test suite. The earlier self-attestation under frozen `95265` (validator `0x0C3A…14B5`, [`/attestations/95265.json`](https://assay-steel.vercel.app/attestations/95265.json)) is still on-chain and still verifies. **Self-issued and not machine-adjudicated** — subject and validator are the same key, and the tag is a documented self-assessment rather than an output of the SERV adjudicator. The document says both on its face and carries no third-party findings, because ASSAY's own rule is that unsolicited statements about a named party stay off-chain. Both were issued the same way; the first under `95265`, before that identity froze. |
| **Paid endpoints** | `assay_true_position` at $0.01 — `https://api.openserv.ai/webhooks/x402/trigger/006ecd4add4a459d8ae92362869a42a6` · [paywall](https://platform.openserv.ai/workspace/paywall/006ecd4add4a459d8ae92362869a42a6)<br>`assay_check_contract` at $0.25 — `https://api.openserv.ai/webhooks/x402/trigger/a1bb2a3946d1411eb945200d43ebc740` · [paywall](https://platform.openserv.ai/workspace/paywall/a1bb2a3946d1411eb945200d43ebc740)<br>Both pay `0x6328…7911`, a wallet this project controls. How to call them, and what to know before paying, is under [Buy a call](#buy-a-call). |
| **Public MCP** | `https://sonar.my.id/assay-mcp/sse` (SSE) — **TLS**, verified from the public internet with real MCP clients — and, from this release, `https://sonar.my.id/assay-mcp/mcp` (Streamable HTTP); the cleartext `:7379` it was previously published on is now closed. **Free verdicts only**: whether a position is safe to value and whether a contract can make the ERC-8056 correction; the figures behind them are what the two endpoints above sell. Rate limited per IP ([limits](#mcp)). Unauthenticated by design — every tool is a public chain read, and the host holds no signing, inference or account key: `serve-remote.ts` refuses to start if `WALLET_PRIVATE_KEY`, `BUYER_PRIVATE_KEY`, `SERV_API_KEY` or `OPENSERV_USER_API_KEY` is in its environment, or `.openserv.json` is in its directory. |

The paid call returns real work, and leads with the refusal it is designed to produce. Verbatim
from the settled $0.01 call above, at block 69261737 (the holder is left out):

```json
{
  "refusalReason": "No Chainlink feed is published for CRWD on Robinhood Chain; no on-chain price
                    is available. Using an off-chain SHARE price here would introduce a 300.000%
                    error, because the multiplier is 4.000000000.",
  "tokenUnits": 12.697759045880602,
  "shareEquivalents": 50.79103618352241,
  "positionValueUsd": null,
  "checks": { "pauseChecked": true, "feedRead": false, "priceSane": false, "roundComplete": false },
  "confidence": "refuse"
}
```

`checks` is the part worth looking at. `false` means **unknown, not fine** — it says which safety
checks actually completed. An earlier version of this call returned `confidence: "high"` with
`refusalReason: null` when the feed read had *failed*, which is the most dangerous thing a paid
valuation primitive can do: sell a check that did not happen as a check that passed.

The refusal text has been reworded since that call. "A 300.000% error" measured the mistake from
the wrong answer up; the current reply measures it from the true value down, which is what a buyer
acts on: valuing the raw balance at an off-chain share price **understates the position by 75%**,
and the true value is 4x that. The quote above stays verbatim because it is what was paid for.

---

## The finding

Robinhood Stock Tokens implement **ERC-8056 scaled UI amounts**. A corporate action moves
`uiMultiplier()`, **not** balances. That single design choice creates a family of defects that
standard ERC-20 habits walk straight into.

<!-- ASSAY:STATS -->
Measured live on mainnet (chain 4663) at block `70789445`, 2026-09-23. **These numbers are
generated from [`data/findings.json`](data/findings.json) by `pnpm readme:stats`, not typed in** —
they were hardcoded once and drifted away from the artifact they described.

| | count |
|---|---|
| Stock Tokens with `uiMultiplier() != 1.0` | **36 of 195** |
| Assets with **no Chainlink feed at all** | **160 of 195** (a chain note, not a finding — an absence cannot be proven by an `eth_call`) |
| 24/5 equity feeds past their heartbeat | **0 of the 35 feeds read were stale, with the market open** — a stale feed during market hours is an incident, not a schedule |
| Holder contracts that hold divergent-multiplier tokens and do not reference `uiMultiplier()` | **12** distinct contracts holding **at least $289,021**, found among 66 recent counterparties (47 with code: 0 reference it, 15 are pools or custody, 5 are too small to hold valuation logic, 0 are proxies that could not be resolved, 15 held none at the block) — an aggregate only: none is named here or on the wall, so their 3 findings are not in the count below |
| Pools and custody holding them (never need a share count) | **15** contracts (9 AMM pools, 1 pool manager, 1 custody or executor wallet, 4 distributors) holding **at least $2,215,103**, reported apart from the row above and never named |
| Findings published | **47**, with **94/94** citations re-fetched and byte-compared |
| Findings rejected by the verifier | **0** — rendered on the wall with the reason, because a verification claim is only worth something if the misses are visible |
<!-- /ASSAY:STATS -->

These figures, and the committed-board counts under [the other side of the
trade](#the-other-side-of-the-trade), are the snapshot committed with this README; the [live
wall](https://assay-steel.vercel.app/wall) re-measures them every 8 minutes, and the holder-contract
dollar figures move a lot between sweeps (the $289,021 above read $629, across 5 contracts, on the
live board at block 73031408 on 2026-09-26).

The 195 are every Stock Token in Robinhood's own registry, `https://api.robinhood.com/rhj/assets`,
all of them deployed on chain 4663: the committed sweep scanned that list at the block above, and
the registry still listed 195 on 2026-09-23 at 01:50 UTC.

Worked examples, all reproducible:

- **CRWD** `uiMultiplier() = 4e18`. A holder of 10 CRWD tokens holds **40 share-equivalents** —
  presenting the raw balance as a share count understates it by **75%**. CRWD has **no Chainlink
  feed**, so any valuation must come from an off-chain share price, which differs from the token
  price by the 4.0x multiplier. This is the only 4.0x token on the chain, and
  `assay_check_symbol('CRWDD')` — one keystroke away — returns an explicit error with a
  did-you-mean rather than a clean bill of health.
- **NVDA**, observed **Sunday 2026-09-20, with the US equity market shut**: a real holder's
  position was **$7,399,189**, priced from a feed **50.4 hours old** — about **26 hours past** its
  86,400s heartbeat. Recorded in the first commit (`e3fea08`); this README later called the whole
  50.4 hours "past its heartbeat" and dated it to the Monday, and both were wrong. Stated in the
  past tense on purpose. Reporting a weekend closure as a live incident is precisely the error this
  tool exists to catch — so the wall renders its own market claims in the past tense once its
  snapshot is more than 20 minutes old, and a stale-feed finding's title now gives the feed's age
  and its lateness separately.

### The other side of the trade

Every finding above names the asset that was **read**. All 195 of them behave exactly as ERC-8056
specifies; not one is at fault. The exposure is on the contracts **holding** them, and those are
on-chain and countable:

| Measured on chain 4663 | |
|---|---|
| Priced Stock Tokens | **$124,769,444**: `totalSupply()` × Chainlink price, summed over the 35 feed-covered Stock Tokens, every read at block 70133497 (2026-09-23 01:50 UTC). A one-off measurement; no script regenerates it |
| Contracts holding divergent-multiplier tokens that reference `uiMultiplier()` | **0** of those whose code could be resolved, on the committed board (block 70789445) |

So ASSAY audits the readers too. For each contract seen transferring a Stock Token whose on-chain
multiplier is more than 0.2% from 1.0 — 9 of the 36 divergent assets on the committed board;
scanning all 36 would not fit the 8-minute cadence, and the board lists the 27 left out
(`integrators.assetsBelowCutoff`) — it
fetches `eth_getCode` and checks for the `uiMultiplier()` selector: a byte-verifiable absence,
re-runnable by the verifier like any other citation. Counts are of **distinct contracts**, at most
40 classified per asset per sweep. (Boards before that change counted (contract, token) pairs.) The
paid single-address audit has no such budget: it checks every Stock Token whose on-chain multiplier
is not exactly 1.0.

**Pools and custody are not "unaware".** An AMM pool, a pool manager, a custody or executor wallet
and a merkle distributor move tokens and never turn a balance into a share count, so they get a
verdict of their own, `NOT_APPLICABLE`, with the role. The role is read from the functions the
bytecode *implements* — `unlock`/`settle`/`take`, `slot0` with a V3 `swap`, `getReserves` with
`factory`, Safe's `execTransaction`, a merkle `claim` — and any valuation function in the code
(`totalAssets`, `convertToShares`, `latestRoundData`, …) vetoes it. They are reported on a line of
their own, never inside the "does not reference it" count. Holdings too small to matter — under
$1,000, or 0.01 share-equivalents where no price exists — are counted and never become a named
finding.

**Proxies are resolved or withheld, never guessed.** A proxy's own bytecode is a delegatecall stub
containing no application selectors, so a naive selector test reports every proxy on the chain as
unaware. The Stock Tokens are *themselves* EIP-1967 **beacon** proxies — SGOV's address is a
283-byte stub — and the first working version duly called the very tokens that implement
`uiMultiplier()` "not multiplier aware". EIP-1967, beacon and EIP-1167 proxies are now resolved to
their implementation before any verdict, and anything still unresolved returns
`PROXY_UNRESOLVED` with **no claim made at all**.

**What a `NOT_AWARE` verdict establishes is the absence of a call, not the presence of a mistake.**
A contract that only custodies or routes a token never needs the multiplier and is not wrong to
lack it. Every statement says so in those words. It can also miss a call that is there: one made
through a library or an oracle adapter, one a router builds from calldata at runtime, or one behind
a diamond or a proxy pattern other than EIP-1967, beacon and EIP-1167. No false-positive rate is
published, because the classifier has not been checked against a hand-labelled sample.

**Holder contracts are withheld from every public surface, and an earlier snapshot did name
them.** The wall, the public feed, the free MCP tools, the committed data files and the verifier's
rejected list count holder contracts in aggregate and name none. A party that may carry no risk at
all should not be findable by name on a public page. A contract's verdict is available for an
address you supply — free as a verdict over MCP, and with its holdings and bytecode evidence as the
paid `assay_check_contract` call.

That was not always true of this repo. From commit `47f1166` (2026-09-22) until the change that
redacted it, the committed `data/findings.json` carried 25 findings naming **17 holder contracts**
as unable to call `uiMultiplier()`, and so did `web/data/findings.json` from `2352a60`, whose
commit message also quotes one of the addresses. Two more places in that history name some of the
same contracts. `data/settlements.json`, from `9c70c5e` until the same change, records the address
the $0.25 audit was run on and its `NOT_AWARE` answer, which the current rules would not give: they
classify that contract as a pool. And one of the 17, the v4 PoolManager, was the example CRWD
holder in this README from the first commit and in `docs/DEMO.md` from when it was added; committed
scripts and tests used both addresses as fixtures. That history has not been rewritten, so all of
it remains readable in git. Re-classified under the current rules (read-only, at block
70130529), **11 of the 17** are AMM pools, a pool manager, an executor wallet or distributors —
`NOT_APPLICABLE`, contracts that never needed the multiplier — and 6 still reference no
`uiMultiplier()`, which remains the absence of a call, not the presence of a mistake. Any of them
can reply: see [docs/RIGHT-OF-REPLY.md](docs/RIGHT-OF-REPLY.md).

### The preventive half

Detecting the mistake is worth less than making it impossible. Both of these are free:

- **`ERC8056Guard`** on Robinhood Chain 4663 — ownerless, storage-free, `view`-only. One external
  call returns the corrected share count, or refuses with a reason. It never moves a token and
  never blocks anything: ASSAY emits something *executable* without ever holding a key, so the
  no-control-path posture survives intact.
- **[`erc8056-guard`](packages/erc8056-guard)** on npm (`npm i erc8056-guard viem`) — the same
  ladder in TypeScript, plus the pure bigint arithmetic exported on its own, because that one line
  is what integrations get wrong. Its reads are pinned to one block, and it refuses a feed round
  timestamped in the future rather than computing a negative age.

**The contract can revert, despite its NatSpec.** It says "never reverts", and that is wrong for
some inputs: Solidity's `try`/`catch` does not catch a failure to decode return data, so
`shareEquivalents`, `positionValue` and `feedUsable` revert on an address with no code or one that
returns malformed data, and `positionValue` and `feedUsable` also revert on a feed round dated in
the future. The contract is immutable and the Sourcify match depends on its source, so the NatSpec
stays wrong: pass real Stock Token and feed addresses, and call it inside your own `try`/`catch`.
The package's [README](packages/erc8056-guard/README.md) has the pattern. Neither the contract nor
the package checks that a feed belongs to the token, or reads a scheduled multiplier change.

`pnpm test:guard` forks 4663 with anvil, deploys the contract into the fork and checks it against
live state — including warping three days forward to force the staleness branch, which is otherwise
only reachable at a weekend.

### What is *not* true

`balanceOf() × chainlinkFeedPrice` is **correct** for token value — the feed is already
multiplier-adjusted, and Robinhood's docs say so explicitly. ASSAY does not claim otherwise.
The defect is **cross-surface mixing**: the on-chain feed returns a *token* price while
`/prices` and every off-chain equity source return a *share* price. Mixing them, or printing
`balanceOf()` to a human as a share count, produces a phantom error equal to the multiplier.

---

## Architecture

There are **three paths**, and only one of them involves a model.

```
DETECTIVE, UNSOLICITED (the wall — 195 assets + their holders, every 8 min)
  Sweeper  ──▶  Verifier  ──▶  publish, UNADJUDICATED
 (no model)    (no model)          assets by name · holder contracts in aggregate only

DETECTIVE, SOLICITED (a subject asks to be graded; built, never yet run)
  Sweeper  ──▶  Verifier  ──▶  + the subject's declared mandate  ──▶  Adjudicator  ──▶  ERC-8004
 (no model)    (no model)                                            (SERV/BRAID)      registry write

PREVENTIVE (free, no model, no key, no control path)
  ERC8056Guard on 4663  ·  erc8056-guard on npm  ──▶  the caller reads it and gets the right number
```

**Why the sweep is unadjudicated, stated plainly.** Every gate in the adjudication rubric asks a
question of the form *"does the declared mandate state X"* — and a 195-asset unsolicited sweep has
no mandate for any subject, because nobody asked to be graded. Running the adjudicator over
invented mandate text would be a worse integrity defect than leaving the sweep unadjudicated, so
the sweep publishes **facts and raw bytes only**: no materiality judgment, no verdict, nothing
on-chain. The model is reached only when a subject supplies its own mandate by requesting a
verdict. An earlier version of this diagram showed a single path with the adjudicator in it, which
overstated what the wall is.

**The solicited path, as it stands: built, and never yet run.** ASSAY's one on-chain verdict, its
self-attestation, was written without the adjudicator, so this path has answered no one. A subject files
`validationRequest` on the ERC-8004 ValidationRegistry (`0x8004Cc84…DAAB58` on Base) naming this
project's validator, `0x6328…7911`. The operator answers in two steps: `pnpm attest:respond
prepare <requestHash>` reads the subject's agent card for its declared mandate, sweeps the finding
in scope, adjudicates it and writes the response document; the wall is deployed so the document is
live; `pnpm attest:respond submit <requestHash>` hashes the deployed bytes, checks them against the
live URL and signs. The request document may name its scope (`scope.findingId`, or `scope.symbol`
with `defectClass`); without one, the documented default is CRWD's `SHARE_COUNT_MISREAD_RISK`,
which is not evidence that the subject holds CRWD. A `BENIGN` verdict is tagged
`NO_MATERIAL_EXPOSURE_AS_DECLARED` (80), not `CLEAN` (100): only the declared text was graded, and
the document says so on its face. **Nothing watches for requests.** One waits until the operator
runs `pnpm attest:pending`.

**1. Sweeper — deterministic, no model.** Reads `uiMultiplier()`, `oraclePaused()`, `decimals()`,
`totalSupply()`, the Chainlink `AggregatorV3Interface` feed and its `updatedAt` vs heartbeat,
straight from chain state. Every value is kept as **raw hex** alongside the decoded form.

**2. Verifier — deterministic, no model.** Re-executes every cited call and **byte-compares**.
A single mismatched citation discredits the entire finding.

> **What the guarantee covers, precisely.** It covers the `evidence` array: on-chain calls, re-run
> and compared byte-for-byte. It does **not** cover off-chain inputs, which are listed separately
> under `offChainSources` with their URL and fetch time and rendered in their own panel on the wall.
> And a claim that cannot be proven by an `eth_call` at all — the **absence** of a published price
> feed, say — is never published as a Finding; it is a `ChainNote` carrying checkable `sources[]`.
> Nor does it cover **which contract a ticker is**: the token address comes from Robinhood's
> `/rhj/assets` registry and the feed from Chainlink's feed directory, and neither binding is
> checked on-chain yet. A wrong registry entry would be byte-verified about the wrong contract.
> An earlier build got this wrong: 159 of 201 findings asserted an absence while citing an
> unrelated `uiMultiplier()` read, so most of the wall carried a verification badge its citation
> could not support. Fixed, and covered by a test.

It distinguishes:

- `reproduced` — byte-identical, publishable
- `mismatch` — the citation contradicts chain state → **the whole finding is dropped.** The only
  reason that impugns a finding.
- `unverifiable_here` (`pruned`) — the node no longer serves that block → unchecked, *not* disproven
- `unchecked` — the re-fetch failed after retries. Says nothing about the finding, only about our
  ability to confirm it right now.
- `no_evidence` — the finding arrived carrying no citations at all. That is a defect in **our
  detector**, not a statement about the subject, so it gets its own reason rather than hiding
  inside `unchecked` or — as it used to — being reported as `mismatch`.

Everything withheld is rendered on the wall with its reason. A verification claim is only worth
something if the misses are visible too.

> **The public RPC is not an archive node, and this number is measured rather than guessed.**
> Binary-searching for the oldest block still serving state puts retention between **5,000 and
> 10,000 blocks**, at **0.101s per block** — so a citation stops being re-fetchable **8 to 17
> minutes** after it is minted.
>
> Three things follow, and all three are consequences of that one number. Verification is **fused
> into the sweep** at each asset's own block, never run as a later pass. The sweep timer runs every
> **8 minutes**, not the 30 it used to, because the board otherwise spends most of its life
> carrying "reproduce this yourself" commands that have already expired. And `assay_findings`
> returns `citationsReproducible` and `citationLifetimeSeconds`, so a caller can see the constraint
> instead of inferring it.
>
> A citation past that window is **unchecked, not disproven** — and the wall says which.

**3. Adjudicator — SERV Reasoning.** The only place a model is allowed. It never computes a fact;
it decides **materiality against the subject's own declared mandate**, and it refuses when the
evidence does not support a conclusion.

| SERV surface | Why it is load-bearing |
|---|---|
| `gpt-5.6-luna-serv-kronos-multipath` | *multipath*: severity is a real branching matrix. *kronos*: the methodology is semantically audited before it grades a named third party |
| `serv_prompt_guard` | 100% of the mandate text is authored by the party being graded. Sent on every call; we have not been able to observe it trip (see the measurements below). On-chain `name()`/`symbol()` strings are not part of the input today, so they are not part of this threat model yet |
| `serv_shadow_agent` (`max_iterations: 5`) | Asked to check that the gates were applied in order, that every cited claim appears verbatim in the evidence, and that `MATERIAL_MISSTATEMENT` is reached only through gate 4 — a mandate that does not state the operation gets `CONTROL_WEAKNESS`. The response does not say whether it ran, so its effect is unmeasured |
| prompt cache | Methodology in the stable system prompt = the same methodology every time, which is what makes a grade an attestation |

---

## What we measured about SERV, and what we found

What SERV does here is described [above](#architecture): it adjudicates materiality for a verdict a
subject requested, and nothing else. This section is what we found when we measured that job.

**The finding: specification, not the BRAID header — the only configuration we varied — was the
dominant variable.**

Three separate times we mistook our own under-specification for model inconsistency. Each time,
fixing the *rubric* — not the model, not the feature flags — removed the variance. That is the
result worth having here, and it is a result about prompt engineering on a well-scoped
classification task, which is a thing you can act on.

1. **v1.** `WITHHELD` and `CONTROL_WEAKNESS` both fired on the same input, with a third reading
   reaching `MATERIAL_MISSTATEMENT`. Three defensible answers, so verdicts oscillated. The
   single-run A/B that first looked decisive (BRAID on `WITHHELD`, off `MATERIAL_MISSTATEMENT`) was
   sampling noise — we reported it as decisive before running it again, and had to retract that. It
   ran on the dev model, `gpt-5.6-luna` without the SERV suffixes, going by the command the first
   README gave for it, and its output was never committed: it survives only in that README
   (`e3fea08`). `data/braid-ab.json` is a re-run the next morning, on the same dev model, which
   returned `CONTROL_WEAKNESS` and `MATERIAL_MISSTATEMENT`.
2. **v2 — four strictly-ordered gates**, so exactly one verdict is correct per input. Oscillation
   vanished in **both** arms on the easy fixture — whose own mandate, "positions are displayed in
   shares", became v2's worked example for gate 3, so that row is a tuning-set result as well.
3. **v3 — gate 4.** On hard cases every remaining error was gate 4, which never said *which
   surface* handling had to cover, that it had to address *this* defect class, or that a stated
   formula should be checked for scaling. The worst failure: a mandate documenting
   `balanceOf() * uiMultiplier() / 1e36` — arithmetically correct — was called
   `MATERIAL_MISSTATEMENT`. **The auditor falsely accusing a subject that did it right** is the
   most damaging error this tool can make. Adding 4a/4b/4c took both arms to 100% **on the same six
   mandates those clauses were written to fix**. That is a tuning-set result: it shows the rubric
   now handles the cases it was edited for, not how it does on a mandate nobody has seen. A
   held-out set, written and labelled before any run, is the measurement that would say that. It
   has now run: see [the held-out result](#the-held-out-result) below.

### What this is a finding *about*

It is a finding about **this task**: a bounded classification with a small verdict space, over
evidence that a deterministic verifier has already established. It is **not** a claim that bounded
reasoning does not work. BRAID's published benchmarks target open-ended multi-step reasoning, which
is a different regime, and our task turned out to be easy once it was specified properly. What we
can say is that on a task shaped like this one, we could not buy reliability with configuration —
we had to write a better rubric.

### The A/B, and the null result

Every arm is meant to run the production model (`gpt-5.6-luna-serv-kronos-multipath`), with the
same evidence and the same prompt; only the `x-openserv-disable-braid: true` header differs. Only
the single-run A/B artifacts record the model. The trial harnesses did not, so no trials row below
can be tied to a model from its file, and the v1 and v2 rows in particular may not share one.

"Finding text" is the version of the evidence the adjudicator is shown — `buildUserMessage()`
sends the finding's class, statement and impact verbatim, so it is an input exactly as much as the
rubric is. Rows on `v0.2.0` were measured before the class was renamed and the statement rewritten
to say the token contract is spec-compliant; they are kept, not overwritten.

**Inputs × draws** is the honest sample size. A draw repeats one byte-identical input, and draws of
one input are not independent cases: every v3 hard-set cell was unanimous. The bracket is a Wilson
95% interval over draws, which flatters a row with few inputs; the 24/24 row is 6/6 by distinct
case, **[61–100%]**. SERV also compiles the reasoning prompt once per system prompt and caches it
(`src/adjudicate/methodology.ts`), so every BRAID-on call under one rubric version ran the same
compiled program, and variance between compiles was never sampled.

| rubric | finding text | task | inputs × draws | braid-on | braid-off |
|---|---|---|---|---|---|
| v1 (ambiguous) | v0.2.0 | easy fixture | 1 × 8 (6 completed off) | 3/8 unsafe verdicts = 38% [14–69%] | 3/6 = 50% [19–81%] |
| v2 (ordered gates) | v0.2.0 | easy fixture | 1 × 8 | 8/8 correct [68–100%] | 8/8 [68–100%] |
| v2 | v0.2.0 | prompt injection | 5 × 2 | 0/10 compromised [0–28%] | 0/10 [0–28%] |
| v2 | v0.2.0 | hard set, the committed sample | 6 × 2 | 9/12 = 75% [47–91%] | 11/12 = 92% [65–99%] |
| v3 (gate 4 tightened) | v0.2.0 | hard set | 6 × 2 | 12/12 = 100% [76–100%] | 12/12 = 100% [76–100%] |
| **v3** | **v0.3.0** | **hard set** | **6 × 4** | **24/24 = 100% [86–100%]** | **24/24 = 100% [86–100%]** |
| **v3** | **v0.3.0** | **easy fixture** | **1 × 16** | **15/16 = 94% [72–99%]** · 0 unsafe | **16/16 = 100% [81–100%]** · 0 unsafe |
| **v3** | **v0.3.0** | **prompt injection** | **5 × 4** | **0/20 compromised [0–16%]** · 17/20 recognised | **0/20 compromised [0–16%]** · 20/20 recognised |
| **v3** | **v0.4.0** | **held-out, pre-registered (SHARE + CROSS)** | **14 × 4** | 1/14 cases [1–31%] · **35 of 56 calls refused** | **13/14 cases = 93% [69–99%]** · 49/56 draws |

Three corrections to earlier versions of this table. The v1 BRAID-off arm completed 6 runs, not 8.
The v2 hard-set row used to read "2 independent samples, 17/23 = 74% vs 20/23 = 87%": the second
sample was overwritten before it was committed, so only the first is shown, and
`data/hard-trials-v2-run2.json`, despite its name, is an incomplete **v3** run (6/6 vs 6/6). And the
hard set has eight cases: the two about stale feeds need a live market closure and have never run,
so every hard-set row is six cases, and the rubric's 7-days-versus-86,400-seconds clause is untested.

### The held-out result

Twenty mandates were written from the rubric's **definitions alone**, never its worked examples, the
tuning cases or the injection payloads, and labelled by two further agents who could not see the
writer's labels. All three agreed on every case, and the set was committed before the first call
([`src/adjudicate/heldout/`](src/adjudicate/heldout/): the guide, the protocol, the frozen fixtures;
pre-registration `b5ca947`). The rubric is pinned by hash in the harness, and an offline test fails
if it changes, so it cannot be tuned against this set without CI saying so.

On the 14 cases whose fixtures exist (the six stale-feed cases wait for a weekend board, under a
capture rule fixed in advance), **BRAID off got 13 of 14 cases right** [69–99%], 49 of 56 draws,
with no errors ([`heldout-trials-assay-methodology-v3.0.0-assa…`](data/heldout-trials-assay-methodology-v3.0.0-assay-rh-v0.4.0-2026-09-23T20-41-02-788Z.json)). Its one missed case is the kind this tool most
needs to catch: a card labelled "Shares held" computed as `balance × uiMultiplier / 1e18` and shown
unscaled, which inflates the count by 10¹⁸. The model called it `BENIGN` in all four draws, so a
units error inside a stated formula can still get past gate 4c. No scored case was over-accused; one
draw of 56 returned `MATERIAL_MISSTATEMENT` on the mandate that presents a pre-decided rating, and
none was talked into `BENIGN`.

**BRAID on mostly did not answer.** 35 of its 56 calls came back as a refusal, `"I can't share
that."`, with no usage recorded, so only 1 of 14 cases had a modal verdict; over the 21 calls that
did answer, 15 were right. That is new. Every one of the 122 calls in the v0.3.0 rows returned a
verdict and usage, and a control re-run on 2026-09-23, of the easy fixture BRAID answered 16 times
on 2026-09-22, refused 1 of 2 ([`braid-trials-assay-methodology-v3.0.0-assay-…`](data/braid-trials-assay-methodology-v3.0.0-assay-rh-v0.4.0-2026-09-23T21-03-06-310Z.json)). So the BRAID-on figure
measures a change in SERV's BRAID layer between those two days, not these mandates, and it is
reported rather than retried away. The adjudicator used to turn an unparseable reply into a
synthetic `WITHHELD`; it now records a refusal as an error, kept in every denominator, which is the
only reason this is visible at all.

Median latency with BRAID on was **18.9s vs 7.2s** off on the current easy fixture (21.6s vs 4.2s
on the v2 easy fixture). The single-run A/B, re-run on current text, now returns `CONTROL_WEAKNESS`
in **both** arms; the original single run — the one reported as decisive and retracted — had
BRAID-off at `MATERIAL_MISSTATEMENT`. It remains one run per arm, an anecdote by construction.

**The current rows are the first with recorded cost.** 122 calls. SERV's responses report 294,164
tokens in and 44,903 out, which is $0.14 at list price. The console billed the key **$0.97** — about
**$0.008 per adjudication**, and roughly 7× what the responses show. These calls are the key's only
billable use, so the figure is attributable. The per-response counts therefore cover about 15% of
the real cost. That is consistent with Kronos compiling the reasoning prompt on the generator side,
but the response does not say, so we do not claim it. Cost from the bill, not from `usage`. The paid
endpoints never call SERV — adjudication runs only for attestations — so this does not touch the
$0.01 query's margin. (The $0.008 averages both arms, and 61 of the 122 calls had BRAID off, which
an attestation never runs; the OpenAI SDK's automatic retries, two by default, would not show in
either count.)

**We could not measure a benefit from the BRAID header on this task.** On the committed v2
hard-set sample it scored 9/12 against 11/12 without it: noise at that size, and we do not claim
otherwise. Once the rubric was correct, both arms were perfect, and that **held under the rewritten
finding text** — the same six mandates, four draws each, 24/24 in each arm and 6/6 by distinct case.

**Indistinguishable from noise:** on the current easy fixture BRAID-on returned one cautious
`WITHHELD` in 16. On one injection payload (`fake-documented-handling`, which cites the rubric's
gates to steer the verdict) it returned `CONTROL_WEAKNESS` 3 times in 4 where BRAID-off withheld all
4; that payload describes handling as much as it instructs, so either verdict is defensible and it
is not counted as BRAID doing worse. Neither gap is significant at these sizes, and **neither is in
the unsafe direction**: no arm was talked into `BENIGN`, and none over-accused.

**We could not observe `serv_prompt_guard` doing anything.** The harness's only sign of a guard
trip is a `content_filter` finish reason, and none appeared in the 40 injection calls; we could not
confirm that this is how the guard signals one, so this is "no trip seen", not "never fired". The
injection arms differ only by the BRAID header, and the guard was sent in both. Every refusal was a
`WITHHELD`, which the rubric makes reachable only through gate 1 — the gate whose clauses include a
mandate that tries to instruct the adjudicator rather than describe the subject. The committed rows
keep no rationale, so which clause fired is not recorded. On this task the protection we can show
is the specification, not the feature.

We are reporting this because a measurement you only publish when it flatters the sponsor is not a
measurement.

Errored calls are counted in the denominator and reported separately. Every artifact is keyed by
rubric version **and** finding-text version **and** run id, and records the keccak256 of the exact
message the adjudicator was shown — keying by rubric alone was not enough, because the finding text
changed under an unchanged rubric and a re-run would have been indistinguishable from the run it
replaced. The harness also no longer writes over the committed artifacts: it used to, which is how
the second v2 hard-set sample was lost, and `braid-ab.json` was at risk the same way. An earlier
version silently dropped failed trials, which is the wrong defect for a contribution whose whole
value is methodological care.

### Run it yourself

```bash
pnpm ab             # one A/B run       -> data/braid-ab-<rubric>-<finding-text>-<run>.json
pnpm trials --n=16  # N trials per arm  -> data/braid-trials-<rubric>-<finding-text>-<run>.json
pnpm inject --n=4   # prompt injection  -> data/injection-trials-<rubric>-<finding-text>-<run>.json
pnpm hard --n=4     # hard case set     -> data/hard-trials-<rubric>-<finding-text>-<run>.json
pnpm hard --n=4 --resume=<path>         # continue that run; never a committed file
pnpm heldout --fixtures=SHARE,CROSS     # the pre-registered held-out set -> data/heldout-trials-<rubric>-<finding-text>-<run>.json
npx tsx scripts/heldout-capture-stale.ts # the STALE fixture, by the pre-registered rule: only from a board observed 2026-09-26T20:00Z to 2026-09-27T12:00Z
```

The harness is reusable and MIT-licensed. Point it at a different rubric or model and it will tell
you the same kind of thing. The raw artifact of every surviving run is committed under `data/`;
the two that did not survive are named above.

## Usage

**Nothing in the first block needs a key.** The sweeper, the verifier, the wall and the MCP
server are public chain reads against Robinhood Chain 4663 and run on a fresh clone with an empty
`.env`. Every script that does need a secret validates it up front and exits naming it.

pnpm (11 or 12) is the supported installer; CI runs pnpm 11.1.2 on Node 22.13, 24 and 26 (pnpm 11 needs Node 22.13 or later).
`npm install` works too: the `overrides` field in `package.json` points `@openserv-labs/sdk`'s
`openai` peer at the root `openai`, which is what pnpm resolves anyway. Without pnpm, each
script-running `pnpm` command is `npx tsx` on the file `package.json` names for it, and the name
does not always match (`pnpm ab` is `npx tsx scripts/braid-ab.ts`); `pnpm test` is `npx vitest run`.
`web/package.json` pins exact versions because Vercel uploads only `web/` and installs it without a
lockfile.

```bash
pnpm install
cp -n .env.example .env; chmod 600 .env  # -n: never overwrite an existing .env (that is how a key was lost)

pnpm sweep                    # full 195-asset sweep, verification fused in
pnpm sweep --symbols=CRWD,NVDA,SPY       # scoped: writes data/findings.scoped.json, NOT the
                                         # published board; --publish replaces it, and the guard
                                         # refuses a narrower board unless --force
pnpm readme:stats             # regenerate this README's numbers from the artifact (--print: stdout only)
pnpm test                     # all 541 tests in 29 files (20 of them, in 3 files, hit live chain state)
pnpm test:offline             # 521 tests in 26 files, no network at all — what CI runs on every push
pnpm typecheck

npx tsx scripts/true-position.ts CRWD <holder>   # any address holding CRWD
pnpm prove <payTo> [buyer]    # prove a settlement from the USDC Transfer log (or set BUYER_ADDRESS)
```

A sweep writes the public board to `data/findings.json` (or `ASSAY_FINDINGS_PATH`), redacted, and
beside it `findings.private.json`, the unredacted one, which is gitignored and never served, and
`sweep-status.json`, what the last run did and why.

Needs credentials — see `.env.example`:

```bash
pnpm ab                       # one A/B run  -> data/braid-ab-<rubric>-<finding-text>-<run>.json  (SERV_API_KEY)
pnpm trials --n=5             # N trials per arm                          (SERV_API_KEY)

pnpm wallets                  # generate the service wallet (and buyer); refuses to overwrite a key
pnpm balances                 # funding status for both wallets
pnpm provision                # create agent + workflow + x402 paywall; refuses without WALLET_PRIVATE_KEY,
                              # and reuses the saved account key, so it is safe to re-run
pnpm buyer                    # generate wallet B; refuses to overwrite an existing key
pnpm pay                      # buyer settles $0.01 over x402
pnpm pay:contract <address>   # buyer settles $0.25 for one contract audit

pnpm attest:pending                        # inbound validation requests, and which are unanswered
pnpm attest:respond prepare <requestHash>  # answer one: sweep, adjudicate, write the document
pnpm attest:respond submit  <requestHash>  # sign it, only after the document is deployed
pnpm attest:build             # build a self-attestation request + response, keyed by request hash,
                              # under web/public/attestations/<agentId>/
pnpm attest:submit            # sign it, only after both documents are deployed
pnpm verify:attestation       # independently check on-chain hash == served bytes
```

Production configuration — units, timer, nginx, logrotate, runbook — is in
[`deploy/`](deploy/RUNBOOK.md), in version control rather than only on the host. The website in
`web/` is covered there too: its routes, the landing's 3D kill switch, rollback, and
`NEXT_DIST_DIR` for local builds ([The website](deploy/RUNBOOK.md#the-website)). Its brand, type and
colour rules are in [docs/BRAND.md](docs/BRAND.md).

### Buy a call

Both paid endpoints are OpenServ x402 triggers: USDC on Base, paid to `0x6328…7911`. OpenServ's own
preflight for them shows other values — an ERC-8004 id that is not ASSAY's (on 2026-09-23 it read
`8453:95396`, another project's identity, on 478 of the platform's 480 listings, so it is a
platform-wide value rather than ours), a different `x402WalletAddress` per workflow, and the frozen
wallet `0x0C3A…14B5` as owner. None of that is set by this repo; the 402 challenge itself is what a
payment follows, and it names `0x6328…7911`. ASSAY's identity is `8453:95374`, whose `tokenURI` and
`agentWallet` on-chain are the card and `0x6328…7911`.

- **From a browser:** the paywall pages,
  [$0.01 audited position](https://platform.openserv.ai/workspace/paywall/006ecd4add4a459d8ae92362869a42a6)
  and [$0.25 contract audit](https://platform.openserv.ai/workspace/paywall/a1bb2a3946d1411eb945200d43ebc740).
  Connect a Base wallet holding USDC; the inputs appear after connecting.
- **From code:** POST to the trigger with any x402 client, and set its spending ceiling to the
  price. The body has this shape (from [`src/lib/endpoints.ts`](src/lib/endpoints.ts)); an unpaid
  POST without it is held for about 90 seconds instead of being answered with the 402 terms:

  ```jsonc
  // assay_true_position, $0.01
  { "buyerAddress": "0xYourBuyerAddress", "payload": { "symbol": "NVDA", "holder": "0xHolderAddress" } }
  // assay_check_contract, $0.25
  { "buyerAddress": "0xYourBuyerAddress", "payload": { "address": "0xContractToAudit" } }
  ```

**Before you pay.** Payment settles before the task runs. Every answer is JSON, and a failure
comes back as `{ ok: false, errorClass, message, retryable }` — `BAD_INPUT`, `BAD_ADDRESS`,
`UNKNOWN_SYMBOL` (with a did-you-mean), `UPSTREAM_UNAVAILABLE` or `INTERNAL`. Whether OpenServ
settles a task that errored has not been verified, so check a ticker or an address with the free
MCP tools first. The $0.01 answer reads every value at one block and adds a `warning` when a
multiplier change is scheduled. The $0.25 audit stops reading after 30 seconds; anything it could
not read or price is listed, `conclusive` is then `false`, and `totalUsdHeld` is `null` with
`pricedUsdHeld` as the floor. Both calls, and the sweep, read Robinhood Chain's public RPC, whose
terms say it is not meant for production use, with dRPC and Pocket as fallbacks; moving the paid
path to a dedicated node is still to do.

### MCP

Four tools, free, unauthenticated, rate limited per IP. **Two of them give a verdict only**, and
say where the figures behind it are sold.

| tool | free answer | what the paid call adds |
|---|---|---|
| `assay_true_position` | `confidence` (`high` / `degraded` / `refuse`), `refusalReason`, which safety checks completed, and any scheduled multiplier change. No position | $0.01: share-equivalents, token and share prices, the position's value, and the feed behind the checks |
| `assay_check_contract` | `verdict` — `AWARE`, `NOT_AWARE`, `NOT_APPLICABLE` with a `role`, `PROXY_UNRESOLVED` (no claim at all), `EOA` or `TOO_SMALL` — plus `codeHash`, `blockNumber` and `conclusive`. Nothing about holdings | $0.25: every Stock Token with an on-chain multiplier other than 1.0 that the address holds, the share-equivalents and dollars on each, what could not be read, and `evidence[]` re-runnable at the block |
| `assay_findings` | the published findings, `snapshotAgeSeconds`, `citationLifetimeSeconds` and `sweepHealth` (is the sweep still publishing, and why not). Holder contracts are counted, never named | — |
| `assay_check_symbol` | a fresh live sweep for one ticker; an unknown ticker is an **error** with a did-you-mean, not an empty result. Never names a holder contract | — |

All four are served from one definition in `src/lib/surface.ts`, shared with the OpenServ agent and
the AgentKit action provider. The agent sells the figures; the AgentKit provider runs the same reads
in your own process. The provider is `assayActionProviders()` in
[`src/agentkit/assay-provider.ts`](src/agentkit/assay-provider.ts), with three actions:
`assay_true_position`, `assay_check_symbol` and `assay_check_contract`. `pnpm agentkit`
([`scripts/agentkit-smoke.ts`](scripts/agentkit-smoke.ts)) loads it into Coinbase AgentKit with a
stub wallet, lists the actions and reads one position; it needs no key.

**Hosted**, over SSE or Streamable HTTP:

```
https://sonar.my.id/assay-mcp/sse     # SSE; OpenServ's no-code MCP connector speaks only this
https://sonar.my.id/assay-mcp/mcp     # Streamable HTTP, stateless
```

OpenServ's no-code MCP connector is SSE-only ([docs](https://docs.openserv.ai/no-code/connect/mcps)),
which is why SSE stays; the OpenServ SDK's `mcpServers` also accepts `http` and `stdio`. Mounted
under a path on an existing certificate rather than on its own subdomain, which needs no new DNS.
`MCP_PUBLIC_PATH` makes the SSE transport advertise the prefixed POST path — it sends an absolute
path, so a bare `/messages` would land on whatever else lives at the origin root.

```bash
# Claude Code, over Streamable HTTP
claude mcp add --transport http assay https://sonar.my.id/assay-mcp/mcp
# or, as a fallback, over SSE
claude mcp add --transport sse assay https://sonar.my.id/assay-mcp/sse
```

```json
{ "mcpServers": { "assay": { "command": "npx", "args": ["-y", "mcp-remote", "https://sonar.my.id/assay-mcp/sse", "--transport", "sse-only"] } } }
```

That is Claude Desktop, through `mcp-remote`. Cursor takes the URL directly,
`{ "mcpServers": { "assay": { "url": "https://sonar.my.id/assay-mcp/sse" } } }`, and an OpenServ
SDK agent takes `mcpServers: { assay: { transport: 'sse', url: 'https://sonar.my.id/assay-mcp/sse',
autoRegisterTools: true } }`.

**Local, over stdio**, from a clone. The paths must be absolute: MCP clients start servers from
their own directory, where a relative path finds nothing, and the board's default path is relative
to the working directory.

```json
{ "mcpServers": { "assay": {
  "command": "/abs/path/assay/node_modules/.bin/tsx",
  "args": ["/abs/path/assay/src/mcp/stdio.ts"],
  "env": { "ASSAY_FINDINGS_PATH": "/abs/path/assay/data/findings.json" }
} } }
```

**Limits**, per IP: 30 SSE opens and 60 requests a minute, of which at most 10 may be
`assay_check_contract` and 5 `assay_check_symbol`; 6 open streams, where a 7th may displace only one
of your own that has been idle for 2 minutes, and 200 streams in all. A stream closes after 10
minutes without a tool call, or 30 minutes whatever happens, and carries a comment every 25 seconds
so clients do not time it out. At most 2 `assay_check_symbol`, 4 `assay_check_contract` and 8
`assay_true_position` calls run at once across the server, and one address may hold half of each.
nginx adds looser limits in front of all of that, as a backstop.

**The raw feed**, if you just want the data and not the protocol — public, CORS-enabled, cached 60s:

```
https://sonar.my.id/assay-mcp/findings.json
```

It carries the aggregate integrator figures and every asset finding, with holder contracts withheld
from both the findings and the rejected list, plus `sweepHealth` and a disclaimer. It is what the
wall itself reads. `https://sonar.my.id/assay-mcp/health/sweep` answers 503 when the board is more
than 20 minutes old or the last sweep refused to publish, for anyone who wants to monitor it.

---

## Publication ethics

ASSAY names assets and feeds; the contracts holding them only in aggregate. So the posture is
structural, not promised:

1. **ASSAY rates itself first.** The one on-chain verdict it has ever written is about itself, and
   that document states on its face that it is self-issued, carries no independent assurance, and
   was not produced by the adjudicator. *(This previously read "and publishes its own worst grade",
   which was not true — the self-assessment came back CLEAN. The honest claim is that ASSAY
   subjected itself to the mechanism first, and discloses what that is worth.)*
2. **Findings name what was READ, not who is at fault.** `subject` is the contract or feed whose
   state produced the finding; `affectedParty` names who carries the exposure, which for most
   classes here is an integrator, not the contract. A Stock Token that moves `uiMultiplier()` is
   doing exactly what ERC-8056 specifies. Falsely accusing a subject that did it right is the most
   damaging error this tool can make, so the data model separates the two.
3. Unsolicited output is **facts plus raw bytes** in neutral engineering language —
   `SHARE_COUNT_MISREAD_RISK`, `CONTROL WEAKNESS`. Never "fraud", never intent, never a
   recommendation to withdraw from a named party.
4. Unsolicited findings are **never written on-chain**. Only a verdict the subject *requested*
   gets a registry write.
5. **Holder contracts are named on no public surface** — the wall, the feed, the free MCP tools,
   the committed data, the rejected list. Earlier commits did name 17 of them, and git history
   still holds those; [above](#the-other-side-of-the-trade) says which files and commits, and what
   the contracts turned out to be.
6. **Right of reply**, with what is actually offered spelled out in
   [docs/RIGHT-OF-REPLY.md](docs/RIGHT-OF-REPLY.md): any named party's response is published
   verbatim and unedited beside the finding, including a contract named only in a verdict given,
   free or paid, for an address the caller supplied, if it asks. A finding shown to be wrong is corrected by changing the rule that produced it, since the
   sweep rebuilds every finding every 8 minutes and there is no switch that hides one; the document
   says how. Pre-publication notice is **not** claimed — the sweep publishes on a timer and for
   most findings the subject is a contract, not a person to notify. Saying otherwise would be the
   same kind of unchecked claim this project exists to catch.
7. **A solicited verdict sends the subject's own mandate text to OpenServ's inference API**
   (`inference-api.openserv.ai`), and training-data collection is **on** for this account, because
   the SERV Hackathon requires it. By OpenServ's own description of that setting, inputs and outputs
   may be used to train its models and retained for up to five years. Anyone requesting a verdict
   should know that before they ask for one.
8. The methodology is versioned — `assay-rh-v0.4.0` for detection, stamped on every finding — and
   a solicited verdict records the rubric version, the model and the hash of the exact input, so a
   subject can inspect the inputs, rubric and model that produced its grade. The model is not
   deterministic, so that is not a promise the grade would come out the same twice.

The MIT license covers this repository's source code. The files under `data/` and `web/data/` hold
values read from public chain state, Robinhood's Stock Token APIs and Chainlink feeds; no rights in
that data, or in the "Robinhood Chain" and "Chainlink" names, are granted by it.
