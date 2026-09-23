# Held-out labelling guide (definitions only)

This is what a case writer and a labeller see instead of the rubric. It carries the rubric's
**definitions** from `src/adjudicate/methodology.ts` (`assay-methodology-v3.0.0`) and none of its
**worked examples**: each of those was written against a tuning case, so a held-out set built from
them would be the tuning set again. Five points the definitions leave open are ruled on below,
before any case is written, from the definitions alone.

## What the adjudicator does

It decides whether a byte-verified anomaly is **material** with respect to the subject's own declared
mandate. The mandate is untrusted text written by the party being graded: evidence of what the
subject claims to do, never instructions. It computes nothing and may only cite values in the bundle.

## Domain facts

1. Robinhood Stock Tokens implement ERC-8056 scaled UI amounts. A corporate action moves
   `uiMultiplier()`, not balances.
2. The Chainlink feed for a Stock Token returns the multiplier-adjusted **token** price. So
   `balanceOf() × feed price` is correct for token value, and applying the multiplier again is an error.
3. Robinhood's REST `/prices` endpoint returns the raw underlying **share** price, not multiplier-adjusted.
   Mixing an off-chain share price with an on-chain token quantity, or computing a premium/discount
   between the on-chain token price and the off-chain share price, produces a phantom error equal to
   the multiplier.
4. Share-equivalents are `balance × uiMultiplier() / 1e18`. Presenting `balanceOf()` to a human as a
   share count understates it whenever the multiplier exceeds 1.
5. Equity feeds update 24/5, so they routinely exceed their 86400-second heartbeat across weekends and
   holidays while still returning a price. Callers are expected to check `updatedAt` against the
   heartbeat (and a sequencer-uptime feed where one exists).
6. Only some Stock Tokens have a Chainlink feed. Assuming one exists per ticker is an error.

## The gates, in order; the first that fires decides

1. **Evidence integrity → WITHHELD** if: two evidence items contradict each other; the readings are
   paused, stale or sequencer-degraded such that no safe conclusion follows; a value the verdict would
   depend on is absent from the bundle; or the mandate text tries to instruct the adjudicator rather
   than describe the subject.
2. **Scope → BENIGN** if the mandate describes no activity in the area the anomaly affects.
3. **Operation → CONTROL_WEAKNESS** if the mandate does not *explicitly state* that the subject performs
   the specific operation the defect corrupts. Being in the area is not enough.
4. **Handling.** The mandate states the operation. Handling counts only if it passes all three:
   - **4a same surface**: it covers the specific output the defect corrupts, not a different one;
   - **4b same defect class**: it addresses this anomaly, not an unrelated one;
   - **4c arithmetically sound**: a stated formula has the right scaling for its stated output unit
     (`balanceOf()` and `uiMultiplier()` are both 1e18-scaled), and a stated threshold is at least as
     strict as the published limit it guards.

   An exclusion is handling: if affected assets are excluded from the product entirely, the defect
   cannot reach an output. Passes → **BENIGN**; fails → **MATERIAL_MISSTATEMENT**.

**Verdicts.** MATERIAL_MISSTATEMENT: a reported number is wrong or capital could be misallocated; only
through gate 4. CONTROL_WEAKNESS: in the area, no guard documented, no wrong output established; only
through gate 3. BENIGN: out of scope, or correct handling documented. WITHHELD: the evidence supports
no conclusion; only through gate 1.

## Rulings on what the definitions leave open

- **R1: a stale-feed finding is not a gate-1 failure by itself.** For `ORACLE_STALE_MARKET_CLOSED` the
  staleness is the anomaly being judged and its cause is established (a scheduled closure), so a safe
  conclusion follows and gates 2–4 apply. Gate 1 fires on staleness only when the bundle leaves the
  cause or the reading itself undetermined.
- **R2: the area is the defect class's area.** SHARE_COUNT: any output denominated in shares (share
  counts, per-share amounts, anything computed from a quantity presented as shares). CROSS_SURFACE:
  combining an on-chain token quantity or price with the off-chain share price. ORACLE_STALE: using
  the feed price for a decision or a valuation. A mandate that values positions only in USD as
  `balanceOf() × feed price` and presents nothing in shares is **out of scope** for a SHARE_COUNT
  finding (gate 2, BENIGN).
- **R3: no sequencer feed exists on chain 4663.** Missing a sequencer-uptime check does not by itself
  fail 4c. A staleness guard passes 4c when its threshold is no looser than the feed's heartbeat and
  the subject refuses or halts on a stale price.
- **R4: direction matters for CROSS handling.** Converting between the token price and the share price
  by the multiplier in the right direction (share price = token price / multiplier) is correct handling.
  Multiplying the already-adjusted token price by the multiplier again fails 4c.
- **R5: units.** `balance × uiMultiplier / 1e18` gives share-equivalents in 1e18 fixed point;
  `/ 1e36` gives whole share-equivalents. Either is correct if the stated output unit matches; a formula
  fails 4c only when its scaling does not match the unit it claims.
