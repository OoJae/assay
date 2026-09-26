# Demo video — shot list

**Target: 2:00.** Judges are not obliged to watch past 2:00, and X takes 2:20 at most without
Premium, so the strongest beat goes first and nothing is explained that the screen already shows.
The eight beats below add up to exactly 2:00 and do not overlap.

Record at 1920×1080. Terminal at ~16pt, dark. Browser with no bookmark bar, no extensions.

**Before recording**, so nothing stalls on camera:

```bash
cd ~/Desktop/Openserv/assay
npx tsx scripts/test-guard.ts     # once, off camera: warms anvil and the fork (~20s), needs Foundry
open https://assay-steel.vercel.app/wall   # once, off camera: the wall renders per request, so its
                                           # first load on camera should not be a cold start
open https://assay-steel.vercel.app        # the landing, where the video opens
open https://basescan.org/tx/0xc192e7b94cdd9b1ae4c77e4602f3fad75067b96b19fd24c6d5d2441a4febc3b2
```

Every script this video runs is started with `npx tsx`, not pnpm, because pnpm checks the install
before every script, and on the recording laptop that check has failed before
(`ERR_PNPM_IGNORED_BUILDS`); an install error on camera costs more than the longer command.

Have three tabs ready in this order: the landing · a terminal · Basescan. The wall opens from the
landing, in the same tab. Pick a CRWD holder for the 0:48 beat beforehand: any **EOA** from
CRWD's Blockscout page (token [`0xea72…3931`](https://robinhoodchain.blockscout.com/token/0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931?tab=holders),
Holders tab), never a contract, because a contract holding a Stock Token is exactly what ASSAY
does not name.

**Check the landing before rolling**, because the opening beat depends on all four:

- **Reduce motion is off** (System Settings → Accessibility → Display). The landing honours it: with
  it on, the five steps are still frames stacked down the page, with no scroll scene and no strike.
- **The bar is moving, not still.** Scroll the landing to the bottom once, reload, and wait a few
  seconds at the top for the 3D bar to fade in. If still frames crossfade instead, the URL has
  `?3d=0`, the browser has no WebGL2, Save-Data is on, or the 3D kill switch is set in production
  (`deploy/RUNBOOK.md`, "The 3D kill switch"). The frames carry the same five steps and can be
  recorded, but try another browser first.
- **The provenance line says *live board*,** not *committed snapshot*. The second means the site
  cannot reach the live feed, and the wall will say `LIVE FEED UNREACHABLE` too. Fix that first.
- **The bar is stamped CRWD.** The landing uses the CRWD finding when the board has one and the
  largest share-count gap otherwise, and the narration below names CRWD and says "four".

---

## 0:00–0:21 — The assay, in one scroll

**Show:** the landing at <https://assay-steel.vercel.app>, on its hero. Scroll down at a steady
pace, three to four seconds a step, through the five steps of the assay. Scroll down only: the
strike fires each time step 03 is crossed going down.

**Say**, one line as each step's label arrives:

| on screen | what it shows | say |
|---|---|---|
| the hero | the bar, and the thesis | "Stock Tokens on Robinhood Chain follow ERC-8056: a corporate action moves a multiplier, not balances." |
| **01 weigh** | `totalSupply()`, and CRWD's supply in tokens | "ASSAY weighs CRWD's supply, read from chain state." |
| **02 read the multiplier** | `uiMultiplier()`, ×4.000000000 | "Its multiplier is four." |
| **03 strike** | the punch comes down once; a gold hallmark appears, carrying the raw return bytes `0x…3782dace9d900000` and the block | "It strikes the raw bytes it read, and their block." |
| **04 divide** | the bar splits along its scored lines into four, and the share-equivalents | "So each token is four share-equivalents." |
| **05 re-fetch** | how many citations were re-fetched and byte-compared before publication, and the sweep's block | "And every citation is re-fetched and byte-compared before it's published." |

Hold on 03 for a moment: the strike is the one loud beat on the site. Do not read the supply or the
share-equivalents aloud; they come from the live board and change between takes. If 05 shows fewer
citations re-fetched than published, say what it says instead of "every".

---

## 0:21–0:33 — Try it

**Show:** click **Wall** in the header. On the wall, click **Check a wallet · free** under the
headline, then **Try the burn address 0x…dEaD** under the box.

**Say:**
> That was one token. Paste any address: for every Stock Token whose multiplier isn't one, a free
> contract on the chain puts the real share count next to the raw balance.

**On screen:** the table fills: `balanceOf() · tokens` next to `Share-equivalents`, one row per
token the address holds. Point at a row where the two columns differ. Do not read the numbers;
they move with the address.

---

## 0:33–0:48 — The bytes, re-fetched

**Show:** scroll back up to the headline and click the finding its paragraph links as the largest
gap on the board: CRWD, the only 4.0x Stock Token.

**Say:**
> These are the bytes the landing struck, with the command to re-fetch them yourself. And notice
> the name: misread *risk*. CRWD's contract does exactly what the spec says; the exposure is on
> whoever reads it wrong.

**Run**, pasted from the finding page (it prints the exact command, `--block` included):

```bash
cast call 0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931 "uiMultiplier()" \
  --block <n> --rpc-url https://rpc.mainnet.chain.robinhood.com
```

**On screen:** `0x…3782dace9d900000`, which is 4e18. Point at it, then at the same raw bytes on
the page. If the block has aged out (8–17 minutes), the page already says *unchecked here, not
disproven*; point at that instead, it is the same point made more honestly.

---

## 0:48–1:05 — It refuses. That is the product.

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
> This is the call people pay a cent for, and it refuses. CRWD has no Chainlink feed, so there's no
> honest on-chain price, and an off-chain share price times the raw balance comes out seventy-five
> percent low. `false` in `checks` means unknown, not fine.

---

## 1:05–1:20 — The other side of the trade

**Show:** back to the wall, scrolled to **Who holds the exposure**.

**Say** only what the panel says; it is written for exactly this:
> The tokens do what the spec says, so ASSAY checks the bytecode of the contracts holding them for
> the `uiMultiplier` selector. Pools and custody get their own line, and no address is on the page:
> contracts are counted, never named.

**On screen:** point at the count, then at the separate pools-and-custody line.

---

## 1:20–1:33 — The mistake becomes impossible

**Run** (warm from the pre-roll; cut the fork's startup in the edit):

```bash
npx tsx scripts/test-guard.ts
```

**Say:**
> Better still, prevent the mistake. A free, ownerless, view-only contract on Robinhood Chain.
> This forks the chain, deploys it, and jumps three days ahead so the feed goes stale.

**On screen:** let these land.

```
  ok   CRWD shares == balance x 4.0 — …
  ok   after +3 days the feed is REFUSED — …
  ok   positionValue refuses rather than pricing off a stale feed — …
```

> It returns nothing instead of something wrong.

---

## 1:33–1:49 — Where SERV Reasoning runs

**Show:** the wall, scrolled to **Where SERV Reasoning runs**.

**Say:**
> When a subject asks for a verdict about itself, SERV Reasoning decides one thing: is a verified
> finding material to its own mandate? It never computes a number. This one is on a test mandate,
> and what we measured is published.

**On screen:** the recorded adjudication card, whose mandate the card labels a measurement fixture,
then the paragraph under it.

---

## 1:49–2:00 — It settles

**Show:** the Basescan tab.

**Say:**
> And it settles. A buyer script paid a quarter for a contract audit over x402, zero ETH from the
> buyer. Both wallets are mine: plumbing, not demand.

**End card:** `assay-steel.vercel.app` · `github.com/OoJae/assay` · `8453:95374` · *Independent;
not affiliated with Robinhood or Chainlink.*

---

## Notes

- **Do not run a sweep for this video**, locally or scoped. The wall reads the host's board, which
  re-sweeps every 8 minutes; a local run takes minutes and changes nothing on the wall.
- **The landing and the wall can show different blocks.** The landing is rebuilt from the live
  board at most once a minute, the wall on every load. CRWD's multiplier bytes are the same on
  both; do not present their blocks as one read.
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
