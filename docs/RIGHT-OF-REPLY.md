# Right of reply

ASSAY publishes findings that name the Stock Tokens and Chainlink feeds whose state it read.
Contracts that merely **hold** Stock Tokens are not named on any public surface — the wall, the
public feed, the findings the free MCP tools return and the committed data files count them in
aggregate only — and a contract is named to anyone in two places, both answering for an address the
caller supplied: the free MCP verdict (`assay_check_contract`) and the paid $0.25 contract audit.
Anyone named in a finding or a contract verdict has a right to have their response published,
**unedited**.

One disclosure first. The copy of `data/findings.json` committed from 47f1166 (2026-09-22) up to
the change that redacted it, and `web/data/findings.json` from 2352a60, contain 25 findings that
name 17 holder contracts; the message of commit 2352a60 quotes one of their addresses.
`data/settlements.json`, from 9c70c5e until the same change, records the address the $0.25 audit
was run on and its `NOT_AWARE` answer, which the current rules would not give: they classify that
contract as a pool. One of the 17, the v4 PoolManager, was also the example CRWD holder in the
README from the first commit and in `docs/DEMO.md` from when it was added, and committed scripts and
tests used both addresses as fixtures. That history has not been rewritten. If your contract is one
of them, everything below applies to you.

## What was previously claimed, and what is true

The README and the wall footer said *"right of reply is live **before** publication."* That was
**not true**, and it is the kind of claim this project exists to catch. The sweep runs on an
8-minute timer and publishes as soon as verification passes; nobody is notified first, and for
most findings here there is no natural person to notify — the `subject` is a smart contract and the
`affectedParty` is a class of integrators, not a named company.

Pre-publication notice is therefore not offered, because it could not be honoured. What is offered
instead is below, including what each part actually takes, because a promise with no mechanism
behind it is the same kind of claim.

## What is offered

1. **Publication of your reply, unedited and in full**, with your attribution and the date. ASSAY
   does not summarise, trim or rebut inside your text. If ASSAY disagrees it says so separately and
   clearly labelled.
2. **Correction of any finding shown to be wrong.** A finding whose citation does not reproduce is
   already dropped automatically; this covers what automation cannot catch — wrong framing, wrong
   affected party, a verdict the bytecode does not support.

   **How a correction actually happens.** There is no switch that hides one finding. The sweep
   rebuilds every finding from chain state every 8 minutes, so a finding removed by hand would be
   back 8 minutes later. A correction is a change to the rule that produced the finding: the
   detector (or, for a contract verdict, the classifier) is changed, the detection methodology
   version stamped on every finding is bumped (`assay-rh-v0.4.0` in the current code; boards
   written before it, the committed one included, say `assay-rh-v0.3.0`), the change is committed
   and deployed to the host, and from the next sweep the finding is either published in its
   corrected form or no longer produced. The free contract verdict and the paid contract audit run
   the same classifier, so both change for every later caller at the same moment. A correction
   notice is recorded in `data/replies.json` with `outcome` set to `correction` or `withdrawn`.
   While the finding is on the board the notice renders on its page; a finding that is no longer
   produced has no page, so its notice stays in `data/replies.json` and the git history.
3. **Reproduction on request.** Every finding carries its contract, call, block and raw return
   bytes, plus the methodology version. If the cited block has aged out of the public RPC's
   retention window, ASSAY will re-run the check at a current block and publish the result whether
   or not it still supports the finding.

## If a contract verdict named your contract

The free MCP verdict and the $0.25 audit both answer for an address the caller supplied and publish
nothing, so you may not know it happened, and there is no finding page or finding id to reply to.
What you can do:

- Open an issue (below) with **your contract's address** in place of a finding id. ASSAY re-runs
  the classifier on it at a current block and answers in the issue with the verdict and the same
  bytecode evidence the paid audit returns.
- If the verdict is wrong for your contract — it calls `uiMultiplier()` through a library or an
  adapter, say, or it is a pool, custody or distribution contract the fingerprints missed — the
  classifier is corrected as in point 2, which changes the answer every later caller gets.
- Your reply is published **only if you ask**, because publishing it names your contract, which
  ASSAY otherwise never does. It is then committed to `data/replies.json` under
  `address:<your address>`.

Two gaps, stated rather than hidden: the wall renders no address-keyed reply, because no public
page names the contract, and neither the free verdict nor the paid audit attaches replies to its
answer yet. A reply about a contract named in a contract verdict is therefore public only in the
repo.

## How to exercise it

- **Open an issue:** <https://github.com/OoJae/assay/issues/new?template=right-of-reply.md>

State the finding id, which is the last part of the finding page's URL: for
<https://assay-steel.vercel.app/f/CRWD-share-count> it is `CRWD-share-count`, and
`SPY-cross-surface` is another. For a contract named in a contract verdict, give its address
instead.

A signed message (EIP-191) from the subject contract's deployer or owner, pasted into the issue, is
accepted as attribution. If you would rather not discuss it in public, open an issue that says
only that and how to reach you; nothing else from it is published.

ASSAY's operator is the owner of ERC-8004 identity **`8453:95374`**,
`0x6328f2fE483922721D94b33eE99e9938Da3b7911`. That address is named so you can check which identity
the findings, attestations and payments belong to. It has no inbox: a message cannot be sent to
it, which is why the channel above is an issue.

The template sets no label: the repo has only GitHub's default labels. Issues are found by their
`[Right of reply]` title prefix.

## Target response time

Replies are attached within **72 hours** of receipt. This is a hackathon project run by one person;
if that slips, the delay is disclosed on the finding rather than quietly absorbed.

## How replies are stored

`data/replies.json`, committed to the public repo, keyed by finding id (or `address:<0x…>`, above).
Each entry carries the reply text verbatim, who sent it, when it was received and published, an
optional `outcome` (`correction`, `withdrawn` or `no-change`), and optionally an ASSAY response
clearly labelled as such.

The wall copies that file when it is built (`web/scripts/prebuild.mjs`), so a reply appears after
the next deploy, not the moment it is committed. It renders on the finding page, in its own panel
above the footer, with any ASSAY response visually separated from the reply itself. A finding with
no reply says so there and links this document. *(An earlier version of this paragraph also
promised a badge on the findings table row. There is no such badge — the claim was written before
the feature and never matched it.)*

Nothing in that file is ever edited after publication except to add an ASSAY response or a
correction notice. The git history is the audit trail.
