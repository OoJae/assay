# Demo video — shot list

**Target: 2:00.** Judges are not obliged to watch past 2:00, and X takes 2:20 at most without
Premium, so the strongest beat goes first and nothing is explained that the screen already shows.
The seven beats below add up to exactly 2:00 and do not overlap.

Record at 1920×1080. Terminal at ~16pt, dark. Browser with no bookmark bar, no extensions.

**Before recording**, so nothing stalls on camera:

```bash
cd ~/Desktop/Openserv/assay
npx tsx scripts/test-guard.ts     # once, off camera: warms anvil and the fork (~20s), needs Foundry
open https://assay-steel.vercel.app
open https://basescan.org/tx/0xc192e7b94cdd9b1ae4c77e4602f3fad75067b96b19fd24c6d5d2441a4febc3b2
```

Every script this video runs is started with `npx tsx`, not pnpm, because pnpm checks the install
before every script, and on the recording laptop that check has failed before
(`ERR_PNPM_IGNORED_BUILDS`); an install error on camera costs more than the longer command.

Have three tabs ready in this order: the wall · a terminal · Basescan. Pick a CRWD holder for the
0:35 beat beforehand: any **EOA** from the holders tab of CRWD's Blockscout page
(`0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931`), never a contract, because a contract holding a
Stock Token is exactly what ASSAY does not name.

---

## 0:00–0:15 — Try it, in the first ten seconds

**Show:** the wall at <https://assay-steel.vercel.app>. Click **Check a wallet · free** in the
header, then **Try the burn address 0x…dEaD** under the box.

**Say:**
> Robinhood Chain has a hundred and ninety-five Stock Tokens. Under ERC-8056 a corporate action
> moves a multiplier, not your balance, so `balanceOf()` is not a share count. Paste any address:
> for every Stock Token whose multiplier isn't one, a free contract on the chain puts the real share
> count next to the raw balance.

**On screen:** the table fills: `balanceOf() · tokens` next to `Share-equivalents`, one row per
token the address holds. Point at a row where the two columns differ. Do not read the numbers;
they move with the address.

---

## 0:15–0:35 — The finding, and the bytes behind it

**Show:** scroll up to the stat row, then click the CRWD finding: the header links the largest gap
on the board, and CRWD, the only 4.0x Stock Token, is it.

**Say:**
> Everything here is re-fetched from chain state before it's published. CRWD's multiplier is
> four, so anything printing the raw balance as a share count is seventy-five percent short. And
> notice the name: misread *risk*. CRWD's contract does exactly what the spec says; the exposure is
> on whoever reads it wrong.

**Run**, pasted from the finding page's evidence block (the page prints the exact command,
including `--block`):

```bash
cast call 0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931 "uiMultiplier()" \
  --block <n> --rpc-url https://rpc.mainnet.chain.robinhood.com
```

**On screen:** `0x…3782dace9d900000`, which is 4e18. Point at it, then at the same raw bytes on
the page. If the block has aged out (8–17 minutes), the page already says *unchecked here, not
disproven*; point at that instead, it is the same point made more honestly.

---

## 0:35–0:55 — It refuses. That is the product.

**Run:**

```bash
npx tsx scripts/true-position.ts CRWD <holder>
```

**On screen:** highlight these fields with the cursor, in order:

```
confidence      "refuse"
checks          { pauseChecked: true, feedRead: false, priceSane: false, roundComplete: false, ... }
refusalReason   "No Chainlink feed is published for CRWD on Robinhood Chain; ... understates the
                 position by 75.000% of its true value ..."
```

**Say:**
> This is the call people pay a cent for, and here it refuses. CRWD has no Chainlink feed, so
> there's no honest on-chain price, and an off-chain share price times the raw balance would come
> out seventy-five percent low. `false` in `checks` means unknown, not fine. An earlier version
> returned high confidence on a read that never happened.

---

## 0:55–1:12 — The other side of the trade

**Show:** the wall, scrolled to **Who holds the exposure**.

**Say** only what the panel says; it is written for exactly this:
> Every finding above names the asset that was *read*, and all hundred and ninety-five behave as
> the spec says. So ASSAY reads the bytecode of the contracts holding them and looks for the
> `uiMultiplier` selector. Pools and custody get a line of their own: they never need a share
> count. And there's no address on the page. The absence of a call isn't the presence of a
> mistake, so contracts are counted, never named. The twenty-five-cent audit answers for an
> address you already have.

**On screen:** point at the count, then at the separate pools-and-custody line.

---

## 1:12–1:28 — The mistake becomes impossible

**Run** (warm from the pre-roll; cut the fork's startup in the edit):

```bash
npx tsx scripts/test-guard.ts
```

**Say:**
> Detecting this is worth less than preventing it. There's a free contract on Robinhood Chain:
> ownerless, no storage, view-only. This forks the real chain, deploys it, and jumps three days
> ahead so the feed goes stale.

**On screen:** let these land.

```
  ok   CRWD shares == balance x 4.0 — …
  ok   after +3 days the feed is REFUSED — …
  ok   positionValue refuses rather than pricing off a stale feed — …
```

> It returns nothing instead of returning something wrong.

---

## 1:28–1:46 — Where SERV Reasoning runs

**Show:** the wall, scrolled to **Where SERV Reasoning runs**.

**Say:**
> SERV Reasoning does the one job here that needs judgement. When a subject asks for an on-chain
> verdict about itself, it decides whether a verified finding is material against the subject's
> own declared mandate: four ordered gates, and it never computes a number. Here's one recorded
> verdict, on a test mandate. We measured it, and published what we found: the rubric was the
> variable that mattered, not the BRAID header, and the perfect score is on the cases we tuned it
> on.

**On screen:** the recorded adjudication card, then the paragraph under it.

---

## 1:46–2:00 — It settles

**Show:** the Basescan tab.

**Say:**
> And it settles. A buyer script paid a quarter for a contract audit over x402: an EIP-3009
> signature, zero ETH from the buyer. Both wallets are mine, so that's plumbing, not demand.

**End card:** `assay-steel.vercel.app` · `github.com/OoJae/assay` · `8453:95374` · *Independent;
not affiliated with Robinhood or Chainlink.*

---

## Notes

- **Do not run a sweep for this video**, locally or scoped. The wall reads the host's board, which
  re-sweeps every 8 minutes; a local run takes minutes and changes nothing on the wall.
- If a cited block has aged past RPC retention, the `cast` call errors. That is a **feature** and a
  good thing to show: unchecked is not disproven, and the finding page says so. Citations die
  **8–17 minutes** after the sweep that minted them (measured), so reload the page for a fresh one.
- If the market is **closed** when filming (Friday 20:00 to Sunday 20:00 New York time), the wall's
  banner says so and feeds going past their heartbeat is expected. Do not narrate it as an
  incident; that is the error this tool exists to catch.
- Keep every claim on screen matched by something on screen. The one thing this project cannot
  afford in a demo is a number nobody can check, so no number is read aloud that the screen does
  not show at that moment, and no balance is read aloud at all.
- **`test-guard.ts` needs `anvil`** (Foundry). Run it once before recording so the dependency is
  not discovered on camera.
- If asked "isn't this just a scanner": the answer is the guard. A scanner tells you; this makes
  the mistake unavailable to anyone who calls it, and gives the number away for free.
