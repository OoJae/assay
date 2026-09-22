# Right of reply

ASSAY publishes findings that name contracts, feeds and the integrators exposed by them. Anyone
named has a right to have their response published alongside the finding, **unedited**.

## What was previously claimed, and what is true

The README and the wall footer said *"right of reply is live **before** publication."* That was
**not true**, and it is the kind of claim this project exists to catch. The sweep runs on a
30-minute timer and publishes as soon as verification passes; nobody is notified first, and for
most findings here there is no natural person to notify — the `subject` is a smart contract and the
`affectedParty` is a class of integrators, not a named company.

Pre-publication notice is therefore not offered, because it could not be honoured. What is offered
instead is below, and it is a real mechanism rather than a promise.

## What is offered

1. **Publication of your reply, unedited and in full**, attached to the finding, with your
   attribution and the date. ASSAY does not summarise, trim or rebut inside your text. If ASSAY
   disagrees it says so separately and clearly labelled.
2. **Correction or withdrawal** of any finding shown to be wrong. A finding whose citation does not
   reproduce is already dropped automatically; this covers the cases automation cannot catch —
   wrong framing, wrong affected party, missing context that changes the reading.
3. **Reproduction on request.** Every finding carries its contract, call, block and raw return
   bytes, plus the methodology version. If the cited block has aged out of the public RPC's
   retention window, ASSAY will re-run the check at a current block and publish the result whether
   or not it still supports the finding.

## How to exercise it

- **Open an issue:** <https://github.com/OoJae/assay/issues/new?template=right-of-reply.md>
- **Or write to the address that owns the agent identity** (`8453:95374`), `0x6328f2fE483922721D94b33eE99e9938Da3b7911`
  — a signed message from the subject contract's deployer or owner is accepted as attribution.

State the finding id (shown on every finding page, e.g. `CRWD-share-count`). If you would rather
not open a public issue, say so in the first line and ASSAY will publish the reply without linking
the issue.

## Target response time

Replies are attached within **72 hours** of receipt. This is a hackathon project run by one person;
if that slips, the delay is disclosed on the finding rather than quietly absorbed.

## How replies are stored

`data/replies.json`, committed to the public repo, keyed by finding id. Each entry carries the
reply text verbatim, who sent it, when it was received and published, and optionally an ASSAY
response clearly labelled as such.

The wall renders it on the finding page, in its own panel above the footer, with any ASSAY response
visually separated from the reply itself. A finding with no reply says so there and links this
document. *(An earlier version of this paragraph also promised a badge on the findings table row.
There is no such badge — the claim was written before the feature and never matched it.)*

Nothing in that file is ever edited after publication except to add an ASSAY response or a
correction notice. The git history is the audit trail.
