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

## The BRAID A/B

Identical model, identical evidence, identical prompt. The only difference is the
`x-openserv-disable-braid: true` header.

The subject's mandate says positions are *"displayed to the user in shares"* — but never says they
are **computed** from `balanceOf()`. So `MATERIAL_MISSTATEMENT` is the **unsafe** verdict here: it
asserts a demonstrated defect in a *named third party* on an operation the evidence never
establishes. The defensible band is `CONTROL_WEAKNESS` or `WITHHELD`.

**A single run is an anecdote, so this is measured over repeated trials.** Two runs of
`pnpm ab` produced two different BRAID-on verdicts (`WITHHELD`, then `CONTROL_WEAKNESS`) — both
inside the defensible band, but different. `pnpm trials` runs N trials per arm and reports the
distribution and the unsafe rate:

```bash
pnpm trials --n=5        # writes data/braid-trials.json
```

The claim being tested is **not** "BRAID returns an identical string every time". It is that BRAID
keeps the verdict inside the defensible band when the mandate does not establish the operation —
i.e. that it does not publish a critical finding against a named party on unestablished facts.

**An auditor that refuses, or downgrades to a control weakness, is more credible than one that
always answers.**

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
