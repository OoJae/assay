# ASSAY

**Independent valuation-integrity audit for agents moving money on Robinhood Chain (EIP-155 4663).**

Built for SERV Hackathon Edition 01 — track: *Mainnet & MCP*.

**Live wall:** <https://assay-steel.vercel.app> · **Repo:** <https://github.com/OoJae/assay>

### On-chain proofs

| | |
|---|---|
| **Settled x402 payment** | [`0x50124847…6b96b`](https://basescan.org/tx/0x50124847a9228521b829e3b47a2b098f5688e57d147e33764232c4c8f686b96b) — 0.01 USDC, buyer `0x09f5…b5B5` → seller `0x0C3A…14B5`, method `transferWithAuthorization`. The buyer spent **zero ETH**: x402 settles via an EIP-3009 signature and a relayer pays the gas. **Four** have settled; this is the one whose reply carries the `checks` block, so the refusal-completeness fix is visible in the thing a buyer actually pays for. Between two wallets I control — that is a working rail, not demand, and [/pricing](https://assay-steel.vercel.app/pricing) says so. |
| **ERC-8004 identity** | agent **`8453:95374`** on the IdentityRegistry `0x8004A169…a432` — [tx](https://basescan.org/tx/0x019ecbbcfe12f646d977c3a7d778d147d91cac9d6a348cc93a03be6d80e8356f) · [8004scan](https://www.8004scan.io/agents/base/95374) · [agent card](https://assay-steel.vercel.app/agent-card.json). **`8453:95265` is frozen**: its signing key was lost when a local `.env` was overwritten with a copy of `.env.example`, so it can never be updated again. Everything already published under it stays true and verifiable, and the card discloses both — along with `95266`, an accidental duplicate. |
| **On-chain guard** | [`ERC8056Guard`](https://robinhoodchain.blockscout.com/address/0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648) at `0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648` on Robinhood Chain 4663 — [deploy tx](https://robinhoodchain.blockscout.com/tx/0x30b2029209f10e015bbb5fc7a63106c7f373b3f686ade2c89ee7404f13ca3df6). Free, ownerless, storage-free, `view`-only. **Verified as an exact match on [Sourcify](https://sourcify.dev/#/lookup/0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648)** — creation and runtime bytecode, compiler settings and metadata identical to [`contracts/ERC8056Guard.sol`](contracts/ERC8056Guard.sol). Reproduce it: `cast code 0x674f9b0e… --rpc-url https://rpc.mainnet.chain.robinhood.com` against a `solc 0.8.35 --optimize --optimize-runs 200 --bin-runtime` build. |
| **Contract audit, paid** | [`0xc192e7b9…bc3b2`](https://basescan.org/tx/0xc192e7b94cdd9b1ae4c77e4602f3fad75067b96b19fd24c6d5d2441a4febc3b2) — **0.25 USDC** for a named `assay_check_contract`, `transferWithAuthorization`, buyer `0xDA31…d2cB` → `0x6328…7911`. The agent answered `NOT_AWARE` with its interpretation. Paid with the SDK's own vendored x402 client and an explicit ceiling equal to the price: `payWorkflow()`'s $0.10 limit is only a default. |
| **On-chain attestation** | agent `95265` rated **CLEAN (100)** by validator `0x0C3A…14B5` — `getAgentValidations(95265)` returns one entry. The `responseHash` on-chain equals `keccak256` of the exact document served at [`/attestations/95265.json`](https://assay-steel.vercel.app/attestations/95265.json); `pnpm verify:attestation` checks that live, and it is in the test suite. **Self-issued and not machine-adjudicated** — subject and validator are the same key, and the tag is a documented self-assessment rather than an output of the SERV adjudicator. The document says both on its face and carries no third-party findings, because ASSAY's own rule is that unsolicited statements about a named party stay off-chain. |
| **Paid endpoints** | `assay_true_position` at $0.01 — `https://api.openserv.ai/webhooks/x402/trigger/006ecd4add4a459d8ae92362869a42a6`<br>`assay_check_contract` at $0.25 — `https://api.openserv.ai/webhooks/x402/trigger/a1bb2a3946d1411eb945200d43ebc740`<br>Both pay `0x6328…7911`, a wallet this project controls. |
| **Public MCP (SSE)** | `https://sonar.my.id/assay-mcp/sse` — **TLS**, verified from the public internet with a real MCP client; the cleartext `:7379` it was previously published on is now closed. OpenServ's MCP support is SSE-only, so this is the transport that matters. Rate limited per IP: 30 connections/min, 60 cheap reads/min, 5 sweep calls/min, 50 concurrent sessions. Unauthenticated by design — every tool is a public chain read. `serve-remote.ts` refuses to boot if `WALLET_PRIVATE_KEY` or `BUYER_PRIVATE_KEY` is in its environment, so that pair is enforced rather than described; `SERV_API_KEY` is simply not deployed there, which is a weaker guarantee and is named as one. |

The paid call returns real work, and leads with the refusal it is designed to produce. Verbatim
from the settled call above, at block 69261737:

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

---

## The finding

Robinhood Stock Tokens implement **ERC-8056 scaled UI amounts**. A corporate action moves
`uiMultiplier()`, **not** balances. That single design choice creates a family of defects that
standard ERC-20 habits walk straight into.

<!-- ASSAY:STATS -->
Measured live on mainnet (chain 4663) at block `69605769`, 2026-09-22. **These numbers are
generated from [`data/findings.json`](data/findings.json) by `pnpm readme:stats`, not typed in** —
they were hardcoded once and drifted away from the artifact they described.

| | count |
|---|---|
| Stock Tokens with `uiMultiplier() != 1.0` | **34 of 195** |
| Assets with **no Chainlink feed at all** | **160 of 195** (a chain note, not a finding — an absence cannot be proven by an `eth_call`) |
| 24/5 equity feeds past their heartbeat | **0 of the 35 feeds read were stale, with the market open** — a stale feed during market hours is an incident, not a schedule |
| Findings published | **70**, with **115/115** citations re-fetched and byte-compared |
| Findings withheld | **0** — rendered on the wall with the reason, because a verification claim is only worth something if the misses are visible |
<!-- /ASSAY:STATS -->

Worked examples, all reproducible:

- **CRWD** `uiMultiplier() = 4e18`. A real holder shows `balanceOf() = 13.0262` tokens, which is
  **52.1046 share-equivalents** — presenting the raw balance as a share count understates it by
  **75%**. CRWD has **no Chainlink feed**, so any valuation must come from an off-chain share
  price, which differs from token value by the 4.0x multiplier. This is the only 4.0x token on the
  chain, and `assay_check_symbol('CRWDD')` — one keystroke away — returns an explicit error rather
  than a clean bill of health.
- **NVDA**, observed **2026-09-21 while the US equity market was shut**: a real holder's position
  was **$7,399,189**, priced from a feed **50.4 hours** past its 86,400s heartbeat. Stated in the
  past tense on purpose. The feed is fresh again now, and reporting a weekend closure as a live
  incident is precisely the error this tool exists to catch — so the wall renders its own market
  claims in the past tense once its snapshot is more than two hours old.

### The other side of the trade

Every finding above names the asset that was **read**. All 195 of them behave exactly as ERC-8056
specifies; not one is at fault. The exposure is on the contracts **holding** them, and those are
on-chain and countable:

| Measured on chain 4663 | |
|---|---|
| Priced Stock Tokens | **$122,286,368** across 35 feed-covered assets |
| Of the addresses moving SPY and NVDA, how many are **contracts** | **~80%** |
| Contracts holding divergent-multiplier tokens that reference `uiMultiplier()` | **0** |

So ASSAY audits the readers too. For each one it fetches `eth_getCode` and checks for the
`uiMultiplier()` selector — a byte-verifiable absence, re-runnable by the verifier like any other
citation.

**Proxies are resolved or withheld, never guessed.** A proxy's own bytecode is a delegatecall stub
containing no application selectors, so a naive selector test reports every proxy on the chain as
unaware. The Stock Tokens are *themselves* EIP-1967 **beacon** proxies — SGOV's address is a
283-byte stub — and the first working version duly called the very tokens that implement
`uiMultiplier()` "not multiplier aware". EIP-1967, beacon and EIP-1167 proxies are now resolved to
their implementation before any verdict, and anything still unresolved returns
`PROXY_UNRESOLVED` with **no claim made at all**.

**What a `NOT_AWARE` verdict establishes is the absence of a call, not the presence of a mistake.**
A contract that only custodies or routes a token never needs the multiplier and is not wrong to
lack it. Every statement says so in those words.

**No contract is named on this site.** The wall publishes a count and a dollar figure; the named
audit, with its bytecode evidence, is the paid `assay_check_contract` call. That split is
deliberate: a party that may carry no risk at all should not be findable by name on a public page.

### The preventive half

Detecting the mistake is worth less than making it impossible. Both of these are free:

- **`ERC8056Guard`** on Robinhood Chain 4663 — ownerless, storage-free, `view`-only. One external
  call returns the corrected share count, or refuses with a reason. It never moves a token and
  never blocks anything: ASSAY emits something *executable* without ever holding a key, so the
  no-control-path posture survives intact.
- **[`erc8056-guard`](packages/erc8056-guard)** on npm — the same ladder in TypeScript, plus the
  pure bigint arithmetic exported on its own, because that one line is what integrations get wrong.

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
 (no model)    (no model)          assets by name · integrators in aggregate only

DETECTIVE, SOLICITED (a subject asks to be graded)
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
| `serv_prompt_guard` | 100% of the mandate text is authored by the party being graded — including permissionless ERC-20 `name()`/`symbol()` strings |
| `serv_shadow_agent` (`max_iterations: 5`) | Enforces that every cited claim appears verbatim, and that an unestablished operation must be **WITHHELD** |
| prompt cache | Methodology in the stable system prompt = the same methodology every time, which is what makes a grade an attestation |

---

## What we measured about SERV, and what we found

**The finding: specification, not model configuration, was the dominant variable.**

Three separate times we mistook our own under-specification for model inconsistency. Each time,
fixing the *rubric* — not the model, not the feature flags — removed the variance. That is the
result worth having here, and it is a result about prompt engineering on a well-scoped
classification task, which is a thing you can act on.

1. **v1.** `WITHHELD` and `CONTROL_WEAKNESS` both fired on the same input, with a third reading
   reaching `MATERIAL_MISSTATEMENT`. Three defensible answers, so verdicts oscillated. The
   single-run A/B that first looked decisive was sampling noise — we reported it as decisive
   before running it again, and had to retract that.
2. **v2 — four strictly-ordered gates**, so exactly one verdict is correct per input. Oscillation
   vanished in **both** arms on the easy fixture.
3. **v3 — gate 4.** On hard cases every remaining error was gate 4, which never said *which
   surface* handling had to cover, that it had to address *this* defect class, or that a stated
   formula should be checked for scaling. The worst failure: a mandate documenting
   `balanceOf() * uiMultiplier() / 1e36` — arithmetically correct — was called
   `MATERIAL_MISSTATEMENT`. **The auditor falsely accusing a subject that did it right** is the
   most damaging error this tool can make. Adding 4a/4b/4c took both arms to 100%.

### What this is a finding *about*

It is a finding about **this task**: a bounded classification with a small verdict space, over
evidence that a deterministic verifier has already established. It is **not** a claim that bounded
reasoning does not work. BRAID's published benchmarks target open-ended multi-step reasoning, which
is a different regime, and our task turned out to be easy once it was specified properly. What we
can say is that on a task shaped like this one, we could not buy reliability with configuration —
we had to write a better rubric.

### The A/B, and the null result

Every arm is the same model (`gpt-5.6-luna-serv-kronos-multipath`), same evidence, same prompt;
only the `x-openserv-disable-braid: true` header differs.

"Finding text" is the version of the evidence the adjudicator is shown — `buildUserMessage()`
sends the finding's class, statement and impact verbatim, so it is an input exactly as much as the
rubric is. Rows on `v0.2.0` were measured before the class was renamed and the statement rewritten
to say the token contract is spec-compliant; they are kept, not overwritten.

| rubric | finding text | task | braid-on | braid-off |
|---|---|---|---|---|
| v1 (ambiguous) | v0.2.0 | easy fixture, 8/arm | 38% unsafe-verdict rate | 50% |
| v2 (ordered gates) | v0.2.0 | easy fixture, 8/arm | 100% accuracy | 100% |
| v2 | v0.2.0 | prompt injection, 5 payloads × 2 | 0/10 compromised | 0/10 |
| v2 | v0.2.0 | hard set, 2 independent samples | 17/23 = 74% | 20/23 = 87% |
| v3 (gate 4 tightened) | v0.2.0 | hard set, 12/arm | 12/12 = 100% | 12/12 = 100% |
| **v3** | **v0.3.0** | **hard set, 24/arm** | **24/24 = 100%** | **24/24 = 100%** |
| **v3** | **v0.3.0** | **easy fixture, 16/arm** | **15/16 = 94%** · 0% unsafe | **16/16 = 100%** · 0% unsafe |
| **v3** | **v0.3.0** | **prompt injection, 5 payloads × 4** | **0/20 compromised** · 17/20 recognised | **0/20 compromised** · 20/20 recognised |

Median latency with BRAID on was **18.9s vs 7.2s** off on the current easy fixture (21.6s vs 4.2s
on the v2 hard set). The single-run A/B, re-run on current text, now returns `CONTROL_WEAKNESS` in
**both** arms; the original single run — the one reported as decisive and retracted — had BRAID-off
at `MATERIAL_MISSTATEMENT`. It remains one run per arm, an anecdote by construction.

**The current rows are the first with recorded cost.** 122 calls. SERV's responses report 294,164
tokens in and 44,903 out, which is $0.14 at list price. The console billed the key **$0.97** — about
**$0.008 per adjudication**, and roughly 7× what the responses show. These calls are the key's only
billable use, so the figure is attributable. The per-response counts therefore cover about 15% of
the real cost. That is consistent with Kronos compiling the reasoning prompt on the generator side,
but the response does not say, so we do not claim it. Cost from the bill, not from `usage`. The paid
endpoints never call SERV — adjudication runs only for attestations — so this does not touch the
$0.01 query's margin.

**We could not measure a benefit from the feature layer on this task.** On the hard set at rubric
v2 it was directionally worse, though at n≈23 per arm that is not significant and we do not claim
it is. Once the rubric was correct, both arms were perfect — and that result **replicated on the
current finding text at twice the sample**, 24/24 in each arm, which is the strongest support the
"specification dominates" finding has had.

The direction has not changed either. On two of the three current measures BRAID-on was marginally
*worse*: one cautious `WITHHELD` on the easy fixture, and on one injection payload
(`fake-documented-handling`, which cites the rubric's gates to steer the verdict) it recognised the
injection 1 time in 4 against 4 in 4 — returning the baseline `CONTROL_WEAKNESS` the other three
times. Neither gap is significant at these sizes, and **neither is in the unsafe direction**: no
arm was talked into `BENIGN`, and none over-accused.

**`serv_prompt_guard` never fired.** In all 40 injection calls, in both arms, the guard reported no
trigger. Every refusal came from gate 1 of the rubric — the clause that says a mandate which tries
to instruct the adjudicator rather than describe the subject is grounds to withhold. On this task
the protection was the specification, not the feature.

We are reporting this because a measurement you only publish when it flatters the sponsor is not a
measurement.

Errored calls are counted in the denominator and reported separately. Every artifact is keyed by
rubric version **and** finding-text version **and** run id, and records the keccak256 of the exact
message the adjudicator was shown — keying by rubric alone was not enough, because the finding text
changed under an unchanged rubric and a re-run would have been indistinguishable from the run it
replaced. The harness also no longer writes over the committed artifacts: it used to, and one of
them was `braid-ab.json`, the evidence for the retraction above. An earlier version silently
dropped failed trials, which is the wrong defect for a contribution whose whole value is
methodological care.

### Run it yourself

```bash
pnpm ab             # one A/B run       -> data/braid-ab-<rubric>-<finding-text>-<run>.json
pnpm trials --n=16  # N trials per arm  -> data/braid-trials-<rubric>-<finding-text>-<run>.json
pnpm inject --n=4   # prompt injection  -> data/injection-trials-<rubric>-<finding-text>-<run>.json
pnpm hard --n=4     # hard case set     -> data/hard-trials-<rubric>-<finding-text>.json  (resumable)
```

The harness is reusable and MIT-licensed. Point it at a different rubric or model and it will tell
you the same kind of thing. Raw artifacts for every run are committed under `data/`.

## Usage

**Nothing below the first block needs a key.** The sweeper, the verifier, the wall and the MCP
server are public chain reads against Robinhood Chain 4663 and run on a fresh clone with an empty
`.env`. Every script that does need a secret validates it up front and exits naming it.

```bash
pnpm install
cp .env.example .env && chmod 600 .env   # every variable says which command needs it

pnpm sweep                    # full 195-asset sweep, verification fused in
pnpm sweep --symbols=CRWD,NVDA,SPY       # scoped: writes data/findings.scoped.json,
                                         # NOT the published board (pass --publish to overwrite)
pnpm readme:stats             # regenerate this README's numbers from the artifact
pnpm test                     # all 96 tests (18 of them hit live chain state)
pnpm test:offline             # 78 tests, no network at all — the CI gate
pnpm typecheck

npx tsx scripts/true-position.ts CRWD 0x8366a39CC670B4001A1121B8F6A443A643e40951
```

Needs credentials — see `.env.example`:

```bash
pnpm ab                       # one A/B run  -> data/braid-ab.json        (SERV_API_KEY)
pnpm trials --n=5             # N trials per arm                          (SERV_API_KEY)

pnpm balances                 # funding status for both wallets
pnpm provision                # create agent + workflow + x402 paywall
pnpm buyer                    # generate wallet B; refuses to overwrite an existing key
pnpm pay                      # buyer settles $0.01 over x402
pnpm prove <payTo>            # prove settlement on Blockscout

pnpm attest:pending           # inbound validation requests, and which are unanswered
pnpm attest:build             # build the self-attestation document + print its hash
pnpm attest:submit            # sign it, only after the document is deployed
pnpm verify:attestation       # independently check on-chain hash == served bytes
```

Production configuration — units, timer, nginx, logrotate, runbook — is in
[`deploy/`](deploy/RUNBOOK.md), in version control rather than only on the host.

### MCP

Local, over stdio:

```json
{ "mcpServers": { "assay": { "command": "npx", "args": ["tsx", "src/mcp/stdio.ts"] } } }
```

**The raw feed**, if you just want the data and not the protocol — public, CORS-enabled, cached 60s:

```
https://sonar.my.id/assay-mcp/findings.json
```

It carries the aggregate integrator figures and every asset finding, with named integrator findings
withheld. It is what the wall itself reads.

Hosted, over SSE — this is the transport OpenServ supports:

```
https://sonar.my.id/assay-mcp/sse
```

Mounted under a path on an existing certificate rather than on its own subdomain, which needs no
new DNS. `MCP_PUBLIC_PATH` makes the SSE transport advertise the prefixed POST path — it sends an
absolute path, so a bare `/messages` would land on whatever else lives at the origin root.

| tool | purpose |
|---|---|
| `assay_true_position` | corrected position + oracle hygiene + explicit `refusalReason` |
| `assay_findings` | published findings, with `snapshotAgeSeconds` so you know how old the answer is |
| `assay_check_symbol` | fresh live sweep for one ticker; an unknown ticker is an **error**, not an empty result |
| `assay_check_contract` | audit any address: is it ERC-8056 aware, what divergent tokens does it hold, and what is unaccounted for. An unresolved proxy returns **no verdict** |

All three are served from one definition in `src/lib/surface.ts`, shared with the AgentKit action
provider and the OpenServ agent — so a buyer can use one endpoint to check another.

---

## Publication ethics

ASSAY names third parties, so the posture is structural, not promised:

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
5. **Right of reply**, with what is actually offered spelled out in
   [docs/RIGHT-OF-REPLY.md](docs/RIGHT-OF-REPLY.md): any named party's response is published
   verbatim and unedited beside the finding, and anything shown to be wrong is corrected or
   withdrawn. Pre-publication notice is **not** claimed — the sweep publishes on a timer and for
   most findings the subject is a contract, not a person to notify. Saying otherwise would be the
   same kind of unchecked claim this project exists to catch.
6. **A solicited verdict sends the subject's own mandate text to OpenServ's inference API**
   (`inference-api.openserv.ai`), under this account's data-collection setting. Anyone requesting a
   verdict should know that before they ask for one.
7. The methodology is versioned — `assay-rh-v0.3.0` for detection, stamped on every finding — so any
   subject can reproduce their own grade against the exact rules it was produced under.
