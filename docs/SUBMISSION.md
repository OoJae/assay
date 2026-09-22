# Submission copy

Everything here is for **Oluwademilade to post** from their own account. Numbers are from the
sweep at block 69217928 (2026-09-22) — re-run `pnpm readme:stats` and re-check before posting.

Links used throughout:
- wall — <https://assay-steel.vercel.app>
- repo — <https://github.com/OoJae/assay>
- settled payment — <https://basescan.org/tx/0x270adb4cfb4daa2858be044cce510d41aa6a75f9f9c803036147d2ec5e7f50de>
- attestation — <https://basescan.org/tx/0xc3809107f422400f8a8324a4c1f5937fbeca3e3c181fbce6bf32da5a9441f669>
- identity — <https://www.8004scan.io/agents/base/95265>

---

## 1. The submission post

Tag **@openservai**. Attach 4 images in this order: the wall's stat row · the CRWD refusal in a
terminal · the Basescan `transferWithAuthorization` · the withheld table (or `/pricing`).

> Built ASSAY for @openservai SERV Hackathon 01.
>
> Robinhood put 450+ tokenized stocks on its own chain. Under ERC-8056 a corporate action moves a
> multiplier, not your balance — so `balanceOf()` is not a share count.
>
> ASSAY swept all 195 live assets and published 45 findings. Every citation re-fetched from chain
> state and byte-compared: 90/90 reproduced.
>
> The part I'd actually defend: it refuses. CRWD has no Chainlink feed, so the paid call returns
> no price and says why, instead of guessing and being 300% wrong.
>
> Live wall, MCP over SSE, x402 at $0.01/call, ERC-8004 identity 8453:95265, and a self-attestation
> whose on-chain hash matches the bytes it serves — verify it yourself with one command.
>
> 🔗 assay-steel.vercel.app
> 🔗 github.com/OoJae/assay

---

## 2. Build-story thread

OpenServ paid a separate $500 "Best Build Story" prize last hackathon. This is written to be worth
reading on its own — the interesting content is the three times I was wrong.

**1/**
> I spent two weeks building an auditor for Robinhood Chain, and the most useful thing I produced
> was a list of the times it was wrong. Thread. 🧵

**2/**
> The pitch: Robinhood's tokenized stocks implement ERC-8056. A dividend or split moves
> `uiMultiplier()` — balances never change. CRWD's multiplier is 4.0. A holder with 13 tokens has
> 52 share-equivalents.

**3/**
> My first thesis was that agents were misvaluing positions by using `balanceOf() × feedPrice`.
>
> That thesis was wrong. The Chainlink feed already returns the multiplier-adjusted *token* price.
> I verified it: SGOV feed $101.1082 vs underlying×multiplier $101.1032. 0.005% apart.
>
> The naive thing is correct.

**4/**
> Which was nearly fatal, and instead made it better. The real defect is **cross-surface mixing**:
> on-chain feeds return a TOKEN price, every off-chain source returns a SHARE price. Mix them and
> your error is exactly the multiplier.
>
> Robinhood's own docs warn about this. Nobody reads that paragraph.

**5/**
> First sweep: 231 findings. 11 rejected by my own verifier.
>
> I assumed a detector bug. It wasn't. The sweep captured one block for all 194 assets, took 12
> minutes, and Robinhood Chain makes 100ms blocks — so by verification time the RPC had pruned the
> state. ~7,000 blocks of drift.

**6/**
> The verifier was treating "I can't check this" as "this is false", and silently deleting TRUE
> findings.
>
> Those are different statements. Now verification is fused into the sweep at each asset's own
> block, and `unverifiable_here` is a distinct outcome from `mismatch`.

**7/**
> Then the headline. I ran the BRAID A/B once — same model, same evidence, only
> `x-openserv-disable-braid` differs — and got a beautiful result. BRAID on: WITHHELD. BRAID off:
> MATERIAL_MISSTATEMENT against a named third party.
>
> I wrote it up as decisive.

**8/**
> Then I ran it again. 40%/75%. Then 38%/50%. Then 100%/100%.
>
> It was sampling noise. I had reported an anecdote as a finding and had to retract it.

**9/**
> Chasing that down produced the actual result, three times over:
>
> Every time I blamed the model for inconsistency, the real problem was my own rubric. v1 had
> three defensible answers for one input. v2 made the gates ordered. v3 fixed the last ambiguity.
>
> Both arms went to 100%.

**10/**
> So: on this task I could not measure a benefit from the feature layer, and specification —
> not model configuration — was the dominant variable.
>
> That's a null result about my sponsor's flagship feature. It's in the README with the harness
> and every raw run, including the ones that don't flatter anybody.
>
> A measurement you only publish when it's favourable isn't a measurement.

**11/**
> Then I adversarially reviewed my own project and found five P0s. Four were mine.
>
> The worst: the attestation. I'd verified the on-chain hash matched the published document — then
> my own `--dry` run overwrote the file, and I committed that copy. The attested bytes existed
> nowhere on earth. My "anyone can verify this" was false for a day.

**12/**
> Second worst: the paid call — the one people spend money on before moving money — returned
> `confidence: "high"` with `refusalReason: null` when the feed read had *failed*.
>
> A check that didn't complete was being sold as a check that passed. It now has an offline test
> matrix that asserts that can never happen.

**13/**
> Third: my cohort logic counted a FAILED RPC read as "not stale".
>
> The bias only ran one way — toward classifying a routine weekend closure as an oracle incident.
> My own network flakiness was biased toward *accusing* people. It now needs an 80% read quorum or
> it reports INDETERMINATE.

**14/**
> And one I caused while fixing another. I put nginx in front of the MCP server for TLS. nginx
> APPENDS to `X-Forwarded-For`, and my rate limiter read the leftmost entry.
>
> 42 requests, no header: 13 got 429. Same burst with a rotating header: zero.
>
> I'd reopened the exact bypass I'd closed that morning.

**15/**
> Every one of those was found by testing, not by reading. The pattern is uncomfortable and
> consistent: I was most wrong where I was most confident, and only measurement fixed it.

**16/**
> Where it landed:
>
> 45 findings, 90/90 citations byte-verified, 195 assets, live MCP over SSE, x402 settled on Base,
> ERC-8004 identity, and a self-attestation that says on its face it carries zero independent
> assurance — because it's me grading me.

**17/**
> The wall also shows what it WITHHELD, and every finding names the asset it READ separately from
> the party who carries the risk. CRWD's contract is spec-perfect. The exposure is on whoever
> reads it wrong.
>
> An auditor that accuses someone who did it right is worse than no auditor.

**18/**
> 🔗 assay-steel.vercel.app
> 🔗 github.com/OoJae/assay
>
> The BRAID harness is MIT. Point it at your own rubric — it'll tell you the same kind of thing it
> told me, which is probably that the problem is your spec.
>
> @openservai

---

## Checklist before posting

- [ ] `pnpm sweep && pnpm readme:stats`, then re-check every number above
- [ ] `pnpm verify:attestation` returns VERIFIES
- [ ] wall loads, `/pricing` loads, a finding page loads, 404 page is styled
- [ ] `curl -s https://sonar.my.id/assay-mcp/health` returns ok
- [ ] demo video recorded per `docs/DEMO.md`, ≤ 2:00
- [ ] submission form <https://form.typeform.com/to/GyPxGqRn> — after the X post
