# ASSAY

**Independent valuation-integrity audit for agents moving money on Robinhood Chain and IXS RWA vaults.**

Built for SERV Hackathon Edition 01 — track: *Mainnet & MCP*.

---

## The finding

Robinhood Stock Tokens implement **ERC-8056 scaled UI amounts**. A corporate action moves
`uiMultiplier()`, **not** balances. That single design choice creates a family of defects that
standard ERC-20 habits walk straight into.

Measured live on mainnet (chain 4663) on 2026-09-20:

| | count |
|---|---|
| Stock Tokens with `uiMultiplier() != 1.0` | **28 of 194** |
| Assets with **no Chainlink feed at all** | **159 of 194** |
| Existing equity feeds **past their own 86400s heartbeat** | **35 of 35 — all of them** |

Worked examples, all reproducible:

- **CRWD** `uiMultiplier() = 4e18`. A real holder shows `balanceOf() = 13.0262` tokens, which is
  **52.1046 share-equivalents**. CRWD has **no Chainlink feed**, so any valuation must come from an
  off-chain share price — which is **300% away** from token value.
- **NVDA** a real holder's position is **$7,399,189**, priced from a feed that is **50.4 hours stale**.

### What is *not* true

`balanceOf() × chainlinkFeedPrice` is **correct** for token value — the feed is already
multiplier-adjusted, and Robinhood's docs say so explicitly. ASSAY does not claim otherwise.
The defect is **cross-surface mixing**: the on-chain feed returns a *token* price while
`/prices` and every off-chain equity source return a *share* price. Mixing them, or printing
`balanceOf()` to a human as a share count, produces a phantom error equal to the multiplier.

---

## Architecture

```
  Sweeper  ──▶  Verifier  ──▶  Adjudicator  ──▶  publish
 (no model)    (no model)      (SERV/BRAID)
```

**1. Sweeper — deterministic, no model.** Reads `uiMultiplier()`, `oraclePaused()`, `decimals()`,
`totalSupply()`, the Chainlink `AggregatorV3Interface` feed and its `updatedAt` vs heartbeat,
straight from chain state. Every value is kept as **raw hex** alongside the decoded form.

**2. Verifier — deterministic, no model.** Re-executes every cited call and **byte-compares**.
A single mismatched citation discredits the entire finding. It distinguishes:

- `reproduced` — byte-identical, publishable
- `mismatch` — the citation is wrong → **the whole finding is dropped**
- `pruned` — the node no longer serves that block → unchecked, *not* disproven

> The public RPC is **not an archive node** — measured, it serves roughly 1k–10k blocks, and
> Robinhood Chain produces ~100ms blocks. Verification is therefore **fused into the sweep** at the
> same block, never run as a later pass.

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

## Does the reasoning layer help? We measured instead of assuming.

ASSAY runs on SERV Reasoning. The interesting question is whether SERV's *feature layer* —
BRAID, Kronos, Multipath, `serv_prompt_guard` — measurably improves adjudication on this task.
We built a harness to find out rather than asserting it. Every arm is the same model
(`gpt-5.6-luna-serv-kronos-multipath`), same evidence, same prompt; only the
`x-openserv-disable-braid: true` header differs.

```bash
pnpm ab            # one A/B run        -> data/braid-ab.json
pnpm trials --n=8  # N trials per arm   -> data/braid-trials.json
pnpm inject --n=2  # prompt injection   -> data/injection-trials.json
pnpm hard --n=2    # hard case set      -> data/hard-trials.json  (resumable)
```

### Results so far

| test | braid-on | braid-off |
|---|---|---|
| Easy fixture, 8 trials/arm | 100% accuracy | 100% accuracy |
| Prompt injection, 5 payloads × 2 arms | 0/10 compromised | 0/10 compromised |
| **Hard set, two independent samples** | **17/23 = 74%** | **20/23 = 87%** |

Median latency with BRAID on was **21.6s vs 4.2s** off.

**On this task we could not measure a benefit from the feature layer, and on the hard set it was
directionally worse.** At n≈23 per arm that difference is not statistically significant and we do
not claim it is — but the direction is consistent across independent samples.

### The more useful finding: specification dominated

Three times we mistook our own under-specification for model inconsistency.

1. **v1 rubric.** `WITHHELD` and `CONTROL_WEAKNESS` both fired on the same input, and a third
   reading reached `MATERIAL_MISSTATEMENT`. Three defensible answers, so verdicts oscillated. The
   single-run A/B that looked decisive (`WITHHELD` vs `MATERIAL_MISSTATEMENT`) was sampling noise:
   repeated trials gave 40%/75%, then 38%/50% on the production model.
2. **v2 ordered gates.** Rewriting the rubric as four strictly-ordered gates made exactly one
   verdict correct per input. Oscillation vanished in **both** arms — 100%/100%.
3. **v3 gate 4.** On harder cases, every remaining error landed on gate 4, which never said *which
   surface* handling had to cover, that it had to address *this* defect class, or that a stated
   formula should be checked for scaling. The worst case: a mandate documenting
   `balanceOf() * uiMultiplier() / 1e36` — which is arithmetically correct — was called
   `MATERIAL_MISSTATEMENT`, i.e. **the auditor falsely accusing a subject that did it right**.
   Gate 4 now has explicit 4a/4b/4c sub-tests.

The reliability in this system comes from deterministic verification and an unambiguous ordered
rubric, not from the reasoning layer. We report that because it is what the data shows, and because
an auditor that over-claims about its own dependencies has no business grading anyone else.

Raw artifacts for every run are committed under `data/`.

## Usage

```bash
pnpm install
cp .env.example .env          # add SERV_API_KEY

pnpm sweep                    # full 194-asset sweep, verification fused in
pnpm sweep -- --symbols=CRWD,NVDA,SPY

npx tsx scripts/true-position.ts CRWD 0x8366a39CC670B4001A1121B8F6A443A643e40951
pnpm ab                       # one A/B run  -> data/braid-ab.json
pnpm trials --n=5             # N trials per arm -> data/braid-trials.json

pnpm balances                 # funding status for both wallets
pnpm provision                # create agent + workflow + x402 paywall
pnpm pay                      # buyer settles $0.01 over x402
pnpm prove <payTo>            # prove settlement on Blockscout

pnpm test                     # verifier tests, run against live chain
```

### MCP

```json
{ "mcpServers": { "assay": { "command": "npx", "args": ["tsx", "src/mcp/stdio.ts"] } } }
```

| tool | purpose |
|---|---|
| `assay_true_position` | corrected position + oracle hygiene + explicit `refusalReason` |
| `assay_findings` | published, byte-verified findings |
| `assay_check_symbol` | fresh live sweep for one ticker |

---

## Publication ethics

ASSAY names third parties, so the posture is structural, not promised:

1. **ASSAY rates itself first** and publishes its own worst grade.
2. Unsolicited output is **facts plus raw bytes** in neutral engineering language —
   `VALUATION DEFECT`, `CONTROL WEAKNESS`. Never "fraud", never intent, never a recommendation
   to withdraw from a named party.
3. Unsolicited findings are **never written on-chain**. Only a verdict the subject *requested*
   gets a registry write.
4. Right of reply is live **before** publication.
5. The methodology is versioned by its cache key, so any subject can reproduce their own grade.
