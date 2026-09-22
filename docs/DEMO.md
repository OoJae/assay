# Demo video — shot list

**Target: 1:50.** Judges are not obliged to watch past 2:00, so the strongest beat goes first and
nothing is explained that the screen already shows.

Record at 1920×1080. Terminal at ~16pt, dark. Browser with no bookmark bar, no extensions.

**Before recording**, so nothing stalls on camera:

```bash
cd ~/Desktop/Openserv/assay
pnpm sweep                       # warm data/findings.json; takes ~10 min, do NOT film this
open https://assay-steel.vercel.app
open https://basescan.org/tx/0x270adb4cfb4daa2858be044cce510d41aa6a75f9f9c803036147d2ec5e7f50de
```

Have four tabs ready in this order: wall · a finding page · Basescan · 8004scan.

---

## 0:00–0:12 — The claim, on screen, in one sentence

**Show:** the wall at <https://assay-steel.vercel.app>, scrolled to the stat row.

**Say:**
> Robinhood put four hundred and fifty tokenized stocks on its own chain. Under ERC-8056, a
> corporate action moves a multiplier — not your balance. ASSAY sweeps all of them and publishes
> only what it can re-fetch and byte-compare.

**On screen:** the stat row reads `45 published · 90/90 citations reproduced · 195 assets swept ·
0 withheld`. Let it sit for a beat. Do not narrate the numbers; they are legible.

---

## 0:12–0:40 — The finding, live, not from a slide

**Run:**

```bash
pnpm sweep --symbols=CRWD
```

Takes ~25s. Talk over it.

**Say:**
> This is live mainnet, right now. CRWD's multiplier is four. So a holder with thirteen tokens
> holds fifty-two share-equivalents — anything printing the raw balance as a share count is
> understating it by seventy-five percent.

**On screen:** the output line

```
[CRITICAL] SHARE_COUNT_MISREAD_RISK  CRWD: reading balanceOf() as shares understates by 75.0000%
```

**Then say — this is the line that separates the project from a scanner:**
> And notice what it's called. Misread *risk*. CRWD's contract is doing exactly what the spec
> says. The exposure is on whoever reads it wrong. We name the asset we read and the party who
> carries the risk in separate fields, because falsely accusing someone who did it right is the
> worst thing an auditor can do.

---

## 0:40–1:05 — It refuses. That is the product.

**Run:**

```bash
npx tsx scripts/true-position.ts CRWD 0x8366a39CC670B4001A1121B8F6A443A643e40951
```

**On screen:** highlight these fields with the cursor, in order:

```
shareEquivalents  50.79
tokenUnits        12.70
checks            { pauseChecked: true, feedRead: false, priceSane: false, roundComplete: false }
confidence        refuse
refusalReason     No Chainlink feed is published for CRWD on Robinhood Chain...
```

**Say:**
> This is the call people pay a cent for. And here it refuses. CRWD has no Chainlink feed, so
> there is no honest on-chain price — and using an off-chain *share* price would introduce exactly
> that four-hundred-percent error. The `checks` block says which safety checks actually completed.
> `false` means unknown, not fine. An earlier version of this returned high confidence on a read
> that never happened, which is the single most dangerous thing a paid valuation call can do.

---

## 1:05–1:25 — Money moves, and it is checkable

**Show:** the Basescan tab, already loaded.

**Say:**
> A second agent paid for that call over x402. Point-oh-one USDC, EIP-3009, on Base. The buyer
> spent zero ETH — a relayer pays the gas.

**On screen:** point at `transferWithAuthorization`, the amount, and the two distinct addresses.

**Then, immediately — do not let this land as a revenue claim:**
> Three payments have settled, between two wallets I control. That proves the rail works end to
> end. It is plumbing, not demand, and the pricing page says so in those words.

**Show:** flick to `/pricing`, let the `roadmap` badges be visible for a second.

---

## 1:25–1:42 — Reproduce it yourself

**Show:** a finding page, scrolled to the evidence block.

**Say:**
> Every citation is the raw return bytes, the contract, and the block. Here is the command that
> reproduces it.

**Run**, pasted from the page:

```bash
cast call 0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931 "uiMultiplier()" \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
```

**On screen:** `4000000000000000000`. Point at it, then at the same bytes on the page.

> Same bytes. And when a citation *doesn't* reproduce, it goes in the withheld table with the
> reason — because a verification claim is worth nothing if you only ever see the hits.

---

## 1:42–1:50 — Close on the measurement, not the pitch

**Show:** the README's SERV section, scrolled to the finding.

**Say:**
> One last thing. We A/B tested our sponsor's own reasoning layer instead of assuming it helped,
> and we could not measure a benefit on this task. What we could measure is that every time we
> blamed the model, the real problem was our own specification. That's in the repo with the
> harness and the raw runs — including the numbers that don't flatter anybody.

**End card:** `assay-steel.vercel.app` · `github.com/OoJae/assay` · `8453:95265`

---

## Notes

- **Do not** film the full 195-asset sweep. It takes minutes. `--symbols=CRWD` is the honest
  short version and the output says exactly what scope it ran.
- If the market is **open** when filming, the wall's banner says so and the stale-feed beat is
  unavailable. Do not reach for it — the weekend staleness story is a past-tense observation and
  the README frames it that way.
- If a cited block has aged past RPC retention, the `cast` call errors. That is a **feature** and
  a good thing to show if it happens: unchecked is not disproven, and the finding page says so.
  Re-run `pnpm sweep --symbols=CRWD` to mint a fresh citation and try again.
- Keep every claim on screen matched by something on screen. The one thing this project cannot
  afford in a demo is a number nobody can check.
