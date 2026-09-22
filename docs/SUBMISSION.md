# Submission copy

Everything here is for **Oluwademilade to post** from their own account. Numbers are from the
sweep at block 69217928 (2026-09-22) — re-run `pnpm readme:stats` and re-check before posting.

Links used throughout:
- wall — <https://assay-steel.vercel.app>
- repo — <https://github.com/OoJae/assay>
- settled payment, $0.01 — <https://basescan.org/tx/0x50124847a9228521b829e3b47a2b098f5688e57d147e33764232c4c8f686b96b>
- settled payment, $0.25 contract audit — <https://basescan.org/tx/0xc192e7b94cdd9b1ae4c77e4602f3fad75067b96b19fd24c6d5d2441a4febc3b2>
- ERC8056Guard on 4663 — <https://robinhoodchain.blockscout.com/address/0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648> (Sourcify exact match)
- attestation — <https://basescan.org/tx/0xc3809107f422400f8a8324a4c1f5937fbeca3e3c181fbce6bf32da5a9441f669>
- identity — <https://www.8004scan.io/agents/base/95374>

---

## 1. The submission post

Tag **@openservai**. Attach 4 images in this order: the wall's stat row · the CRWD refusal in a
terminal · the Basescan `transferWithAuthorization` · the withheld table (or `/pricing`).

> Built ASSAY for @openservai SERV Hackathon 01.
>
> Robinhood put 450+ tokenized stocks on its own chain. Under ERC-8056 a corporate action moves a
> multiplier, not your balance — so `balanceOf()` is not a share count.
>
> ASSAY sweeps all 195 live assets every 8 minutes. Every citation is re-fetched from chain state
> and byte-compared before it is published.
>
> But all 195 assets are innocent — they do exactly what the spec says. So I went looking for who
> actually carries the risk, and found it: **~80% of the addresses holding these tokens are
> contracts, and of the ones holding a divergent multiplier, zero reference `uiMultiplier()`
> anywhere in their bytecode.**
>
> The wall publishes that as a count and a dollar figure. It names nobody — absence of a call isn't
> proof of a mistake, and a contract that just custodies a token isn't wrong to lack it.
>
> Then the part I'd defend hardest: a **free** contract on Robinhood Chain that does the correction
> for you, and refuses — with a reason — when the feed is stale or the oracle is paused. ASSAY never
> holds a key and never blocks anything. It publishes something executable and you choose to read it.
>
> The wall also shows what it **withheld**, and names the asset it *read* separately from the party
> who carries the risk — CRWD's contract is spec-perfect; the exposure is on whoever reads it wrong.
>
> The guard is live at 0x674f…1648 on Robinhood Chain and verified as an exact match on Sourcify.
> Two paid tiers settle over x402 on Base — $0.01 for a corrected position, $0.25 for a named
> contract audit. ERC-8004 identity 8453:95374.
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
> Then I adversarially reviewed my own project. Five P0s, four of them mine. I fixed them, then
> reviewed the fixes — and found fourteen more, several *introduced by the fixes*.
>
> The worst of the first round: the attestation. I'd verified the on-chain hash matched the
> published document — then my own `--dry` run overwrote the file, and I committed that copy. The
> attested bytes existed nowhere on earth. My "anyone can verify this" was false for a day.

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

**14b/**
> The second review round was worse, because those bugs were *newer*. I'd stopped `decimals()`
> silently defaulting to 8 — right call, a wrong exponent is a 10^n error — by returning null.
>
> But the caller reads null as "no feed here." So an unrelated failed read now silently deleted a
> true staleness finding. I'd re-created the retention bug, in a different shape.

**14c/**
> And the log rotation I'd added that morning? Never ran once. systemd opens the log as root
> before dropping to the service user, so my `su ubuntu ubuntu` couldn't truncate it.
>
> `logrotate -f` → exit 1, permission denied, nothing rotated. I only knew because I ran it.

**15/**
> Every one was found by testing, not by reading. The pattern is uncomfortable and consistent: I
> was most wrong where I was most confident, and only measurement fixed it.
>
> Including the numbers themselves. "The RPC prunes within roughly 1k–10k blocks" appeared in six
> files and I'd never measured it. Binary-searched it: 5,000–10,000 blocks, 0.101s each. Citations
> die in 8–17 minutes.
>
> My sweep timer was set to 30. The board spent most of its life publishing "reproduce this
> yourself" commands that had already expired.

**15b/**
> The last thing I built is the one I'd keep.
>
> ASSAY was auditing 195 assets that are all *correct*. The exposure is on whoever reads them. So I
> pulled the Transfer logs, fetched the bytecode of every holder, and checked for the
> `uiMultiplier()` selector.
>
> ~80% of holders are contracts. Of the ones holding a divergent multiplier: zero have it.

**15c/**
> That nearly went very wrong. A proxy's bytecode is a delegatecall stub with no selectors in it —
> so a naive check calls every proxy on the chain "not multiplier aware."
>
> The Stock Tokens are *themselves* beacon proxies. My first version accused the very contracts
> that implement the function.
>
> Proxies are now resolved, or the finding is withheld. No guess.

**15d/**
> And detection is worth less than prevention, so there's a free ownerless contract on 4663 that
> does the correction and refuses when the feed is stale.
>
> Tested by forking the real chain, warping 3 days forward, and watching it say no.
>
> ASSAY holds no key and blocks nothing. It emits something executable; you opt in.

**16/**
> Where it landed:
>
> 195 assets swept every 8 minutes plus the contracts holding them, every citation byte-verified,
> a free guard contract and npm package so the mistake is preventable, MCP over SSE behind TLS,
> x402 settled on Base, ERC-8004 identity, 112 tests of which 94 need no network at all, and a
> self-attestation that says on its face it carries zero independent assurance — because it's me
> grading me.

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
- [ ] `pnpm test:guard` passes (needs `anvil`)
- [x] guard deployed on 4663 (0x674f9b0e…1648), Sourcify exact match, published on the wall and README
- [ ] `pnpm verify:attestation` returns VERIFIES
- [ ] wall loads, `/pricing` loads, a finding page loads, 404 page is styled
- [ ] `curl -s https://sonar.my.id/assay-mcp/health` returns ok
- [ ] demo video recorded per `docs/DEMO.md`, ≤ 2:00
- [ ] submission form <https://form.typeform.com/to/GyPxGqRn> — after the X post
