# Held-out SERV evaluation: pre-registered protocol

Committed before any SERV call on these cases. The commit that adds this file, `cases.ts` and
`fixtures.json` is the pre-registration; the run artifact records its SHA and the cases-file hash.

## Why

The 24/24 hard-set rows are a **tuning-set** result: the v3 rubric's gate-4 text was written against
those same six mandates. This set estimates how the frozen rubric generalises to mandates it was not
edited against.

## Frozen

- Rubric `assay-methodology-v3.0.0`: `METHODOLOGY_SYSTEM_PROMPT` in `src/adjudicate/methodology.ts`,
  the `serv_shadow_agent` hint and the model id in `src/adjudicate/serv.ts`. The harness refuses to run
  if their pinned hash changes, and an offline test fails on the same change.
- Nothing in the rubric is edited in response to these results. A rubric change after this point makes
  a new version, and this set is then no longer held out for it.

## Cases

- 20 mandates: 8 against the SHARE fixture (`CRWD-share-count`), 6 against the CROSS fixture
  (`SGOV-cross-surface`), 6 against a STALE fixture; spread across all four verdicts.
- Written by one agent from `GUIDE.md` and the rendered evidence bundles only, without the rubric's
  worked examples, the tuning cases (`src/adjudicate/hard-cases.ts`) or the injection payloads.
- Labelled independently by two further agents who do not see the writer's label. A case whose three
  labels agree is **scored**; any disagreement makes it **contested**, reported separately with every
  label, and left out of the headline.

## STALE fixture: capture rule

The first `ORACLE_STALE_MARKET_CLOSED` finding, in board order, on the first public board at
`https://sonar.my.id/assay-mcp/findings.json` whose `observedAt` is at or after
**2026-09-26T20:00:00Z**, copied verbatim. If no such finding exists by 2026-09-27T12:00:00Z, the six
STALE cases are not run and are reported as not run.

## Run

- 4 draws per case per arm; two arms, BRAID on (default) and off (`x-openserv-disable-braid`).
- SHARE and CROSS run first; STALE runs after its capture. Calls are sequential.

## Reported

- **Headline:** per-case accuracy over scored cases (a case is correct when its modal verdict across the
  4 draws, per arm, equals the label; a 2–2 split counts as incorrect), with a Wilson 95% interval, per arm.
- Per-draw accuracy, a confusion matrix, results per finding class, over-accusations
  (MATERIAL_MISSTATEMENT where the label is not) and missed defects (BENIGN where the label is not),
  errored calls in the denominator, every rationale, and the contested cases with their labels.
- Whatever the numbers are. A poor result is reported as prominently as a good one would have been.
