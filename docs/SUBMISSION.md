# Submission copy

Everything here is for **Oluwademilade to post** from their own account.

## Deadline and form, first

- **Hard close: 2026-09-28 00:00 UTC**, which is the **end of Sunday 27 September UTC** (Monday
  01:00 at UTC+1, the zone the commits are stamped in). "14–28 September" does not include the
  28th. Aim to have everything in by **Saturday 26 September**.
- **The form is <https://form.typeform.com/to/A475N331>** ("SERV Hackathon #1 submission"). The
  pre-registration form GyPxGqRn, which this file used to link, is **closed and not required**:
  eligibility needs data collection on, not pre-registration.
- **Email on the form: the address you log in to console.openserv.ai with.** The form says it must
  be, because that is how OpenServ matches the entry to the org whose SERV usage it checks. It is
  not your usual address; check the console's Organization page before typing it.
- Judging runs the following week and winners are announced in early October, with a live-streamed
  finalist demo. **Keep the VPS, the wall and both paywalls up until then**, and rotate keys only
  after it.

## In this order

1. [ ] `npm view erc8056-guard version` prints `0.1.0` before the commit that carries this README
       is pushed. The README says the package is on npm; until it is published that line is false,
       and the name is open to anyone.
2. [ ] The code in this change is committed and deployed: the VPS (free MCP verdicts, sweep guard,
       agent) and the Vercel wall and agent card together. The post and the README describe them.
       `git add -u` stages only files git already tracks, so it leaves out every file `git status`
       lists as `??`: the CI workflow, `src/lib/redact.ts`, `src/lib/endpoints.ts`, new tests and
       wall components. Stage those too. Without the workflow the README's CI badge and thread 23/
       are false, so its first run on GitHub must be green before anything is posted.
3. [ ] Every number marked **[refresh]** below re-read from the live wall
       (<https://assay-steel.vercel.app>) minutes before posting. They are written here from the
       committed board, block 70789445 (2026-09-23 20:11 UTC), and the live board moves every 8
       minutes.
4. [ ] Test counts re-run: `ASSAY_OFFLINE_ONLY=1 npx vitest run`, then `npx vitest run`. Written
       below as 491 offline in 24 files and 511 in all 27 files, from runs on 2026-09-23.
5. [ ] `npx tsx scripts/test-guard.ts` passes (needs `anvil`).
6. [ ] `npx tsx scripts/verify-attestation.ts` returns VERIFIES.
7. [ ] The wall, `/pricing`, a finding page and a missing page all load; the free wallet check
       returns rows for `0x000000000000000000000000000000000000dEaD`.
8. [ ] The live MCP host runs this release. Each line should print what its comment says:

       ```bash
       curl -s -o /dev/null -w '%{http_code}\n' https://sonar.my.id/assay-mcp/health/sweep   # 200
       mcp() { curl -s -X POST https://sonar.my.id/assay-mcp/mcp -H 'content-type: application/json' \
         -H 'accept: application/json, text/event-stream' \
         -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
       mcp assay_check_contract '{"address":"0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648"}' \
         | grep -o 'fullAudit\|holdings\|totalUsdHeld' | sort -u                             # fullAudit
       mcp assay_true_position '{"symbol":"CRWD","holder":"0x000000000000000000000000000000000000dEaD"}' \
         | grep -o 'fullAnswer\|shareEquivalents\|positionValueUsd' | sort -u                # fullAnswer
       ```

       A 503 means the board is stale or the last sweep refused; a 404 means the host still runs
       the old code, which serves neither `/health/sweep` nor `/mcp` and gives the figures away
       free. Until all three lines pass, the README's Streamable HTTP and free-verdicts-only claims
       are not true of the live host, so do not post.
9. [ ] Demo recorded per `docs/DEMO.md`: **2:00 target, 2:20 at most**, which is X's video limit
       without Premium. Uploaded to YouTube (unlisted is fine) for the form's second link.
10. [ ] Check whether the posting account has **X Premium**. Nothing below needs it: every post is
        280 characters or fewer as X counts them. Without Premium a video must be 2:20 or shorter.
11. [ ] Post section 1 with its 4 images and **@openservai**. Post the video as the first reply.
12. [ ] Fill the form (section 3). Keep the Typeform confirmation screen or email.
13. [ ] Only then, optionally, the thread in section 2, as replies under the submission post.

When there is time, none of it blocking:
- Set the GitHub repo's homepage to the wall and add topics (robinhood-chain, erc-8056, x402,
  erc-8004, mcp, openserv), so a judge landing on GitHub has one click to the live product.
- Set `git config user.email` to your GitHub noreply address, and only then turn on "Block command
  line pushes that expose my email"; in the other order the next push is rejected. Two personal
  addresses are already in the public history; do not rewrite it during judging.
- Turn on two-factor authentication for the console.openserv.ai account.
- Make a dated copy of `.openserv.json` (see `deploy/RUNBOOK.md`, Secrets), and keep X DMs open
  until winners are announced.

Links used throughout:
- wall: <https://assay-steel.vercel.app>
- repo: <https://github.com/OoJae/assay>
- settled payment, $0.25 contract audit, to the current payTo `0x6328…7911`: <https://basescan.org/tx/0xc192e7b94cdd9b1ae4c77e4602f3fad75067b96b19fd24c6d5d2441a4febc3b2>
- settled payment, $0.01, to the frozen 95265 wallet: <https://basescan.org/tx/0x50124847a9228521b829e3b47a2b098f5688e57d147e33764232c4c8f686b96b>
- ERC8056Guard on 4663: <https://robinhoodchain.blockscout.com/address/0x674f9b0ec3c3643c1f51c0a40d4837932f9c1648> (Sourcify exact match)
- self-attestation under 8453:95374 (self-issued, owner = validator): <https://basescan.org/tx/0x885d978810fbfccace75db1116897791483624c6ac68573fce96ef7a4dcaf1ee>
- identity 8453:95374, mint tx: <https://basescan.org/tx/0x019ecbbcfe12f646d977c3a7d778d147d91cac9d6a348cc93a03be6d80e8356f>
  and the card it points at, <https://assay-steel.vercel.app/agent-card.json>. Not 8004scan: it
  has never parsed the card and shows a nameless "Agent #95374".

---

## 1. The submission post

This is the post whose URL goes on the form. It carries everything the rules ask for: name,
concept, images, links and the @openservai tag.

Attach 4 images in this order: the wall's hero and stat row · the CRWD refusal in a terminal ·
the wall's "Where SERV Reasoning runs" card · the Basescan page of the $0.25
`transferWithAuthorization`.

Paste each block as it is. Links count as 23 characters on X however long they are, and nothing
inside the blocks is markdown. Every block is at most 280 characters; the longest is 279. Count
again after any edit.

**Post**

```text
ASSAY, for @openservai SERV Hackathon 01: valuation-integrity checks for Robinhood Chain Stock Tokens.

Under ERC-8056, balanceOf() is not a share count. ASSAY publishes only what re-fetches byte-for-byte, and refuses when unsure.

https://assay-steel.vercel.app
https://github.com/OoJae/assay
```

**Video reply** (the first reply, with the demo attached)

```text
Two minutes, against live chain state: a wallet check, a refusal, the contracts holding the tokens, a free guard contract, where SERV Reasoning runs, and a settled x402 payment.

Independent project; not affiliated with Robinhood or Chainlink. Not financial advice.
```

---

## 2. The thread (optional)

There is no build-story prize in Edition 01; this file used to say there was, and that $500 prize
belonged to a different hackathon. Post this only after the form is in, as replies under the
submission post, so the form keeps the submission post's URL.

Numbers marked **[refresh]** are from the committed board and must be re-read from the live wall
first. Delete the marker before posting.

**1/**

```text
How ASSAY got built, and the list of times it was wrong, which turned out to be the most useful thing it produced. 🧵
```

**2/**

```text
Where SERV Reasoning runs in ASSAY: when a subject asks for an on-chain ERC-8004 verdict about itself, SERV decides whether a byte-verified finding is material against the subject's own declared mandate. Four ordered gates. It never computes a number.
```

**3/**

```text
Everything else is deterministic: the sweep, the wall and both paid calls use no model, and every number is read from chain state. No subject has requested a verdict yet, so every SERV call so far is the measurement further down.
```

**4/**

```text
The problem: Robinhood Chain has 195 Stock Tokens (Robinhood's /rhj/assets registry, read 23 Sep). Under ERC-8056 a corporate action moves uiMultiplier(), not balances. CRWD's is 4.0: 10 tokens are 40 share-equivalents. Print balanceOf() as shares and you're 75% short.
```

**5/**

```text
ASSAY sweeps all 195 every 8 minutes. On the board at block 70789445: 36 have a multiplier other than 1.0, 160 have no Chainlink feed, and 47 findings are published with 94/94 citations re-fetched byte-for-byte. [refresh]
```

**6/**

```text
First thesis: agents misvalue positions with balanceOf() times the feed price.

Wrong. The Chainlink feed already returns the multiplier-adjusted token price. SGOV at that block: feed $101.1082, underlying × multiplier $101.1183, 0.010% apart. The naive thing is correct.
```

**7/**

```text
The real defect is mixing surfaces. On-chain feeds return a TOKEN price; off-chain sources return a SHARE price. Mix them and the error is exactly the multiplier.

Robinhood's own docs warn about this. ASSAY checks who reads it wrong.
```

**8/**

```text
An early sweep had 11 findings rejected by my own verifier. Not a detector bug: the public RPC serves state for only 5,000 to 10,000 blocks, and a 12-minute sweep on 100ms blocks outlived it. The cited state was gone by the time it was checked.
```

**9/**

```text
The verifier was treating "I can't check this" as "this is false", and silently dropping true findings.

Different statements. Verification now runs inside the sweep at each asset's own block, and unverifiable_here is a separate outcome from mismatch.
```

**10/**

```text
Then the SERV A/B. Same evidence, same prompt, only the x-openserv-disable-braid header differs. My first single run: BRAID on WITHHELD, BRAID off MATERIAL_MISSTATEMENT against a named third party.

I wrote it up as decisive. It also ran on the dev model, not the production one.
```

**11/**

```text
Eight runs per arm later it was noise: an unsafe verdict in 3 of 8 runs with BRAID on and 3 of 6 completed runs with it off. I had reported an anecdote as a finding, and retracted it.
```

**12/**

```text
Every time I blamed the model, the problem was my rubric. v1 allowed three defensible answers. v2 put the gates in a strict order. v3 tightened gate 4. On the hard cases both arms then went 24/24: six distinct cases, four draws each.
```

**13/**

```text
The caveat I owe you: gate 4 was rewritten against those same six cases. So 24/24 is a tuning-set result, not an estimate for mandates nobody has seen. So I wrote 20 new mandates blind, pre-registered them, and froze the rubric: 13/14 with BRAID off.
```

**14/**

```text
BRAID on vs off: no measurable difference on 2026-09-22. A day later BRAID on refused 35 of 56 held-out calls ("I can't share that.") and 1 of 2 on a fixture it had answered 16 times. It's in the README, not retried away.
```

**15/**

```text
Five hostile mandates, 40 calls: none talked the adjudicator into clearing the subject. The refusals were the rubric's gate 1. The harness never saw serv_prompt_guard trip, and I could not confirm how it signals one, so I don't claim it did the work.
```

**16/**

```text
Then I adversarially reviewed my own project. The worst find: the paid call returned confidence "high" with no refusal when the feed read had FAILED. A check that didn't complete, sold as one that passed. An offline test matrix now forbids it.
```

**17/**

```text
One I caused while fixing another. nginx appends to X-Forwarded-For and my rate limiter read the leftmost entry.

42 requests with no header: 13 got 429. The same burst with a rotating header: zero. I'd reopened the bypass I closed that morning.
```

**18/**

```text
"The RPC prunes within roughly 1k to 10k blocks" sat in six files and I'd never measured it. Binary search: 5,000 to 10,000 blocks at 0.101s each. Citations die 8 to 17 minutes after they're minted. The sweep ran every 30 minutes. Now it's 8.
```

**19/**

```text
All 195 tokens do what the spec says. The exposure is on whoever reads them, so ASSAY reads the bytecode of the contracts holding them. At block 70789445, none of the 47 holder contracts referenced uiMultiplier(); 15 are pools or custody, which never need it. [refresh]
```

**20/**

```text
That nearly went wrong. A proxy's bytecode is a stub with no selectors, and the Stock Tokens are themselves beacon proxies: my first version accused the very tokens that implement the function. Proxies are now resolved, or no claim is made.
```

**21/**

```text
Absence of a call isn't a mistake. Pools and custody never need a share count, and now get their own verdict. So holder contracts are counted, never named. Earlier commits in the repo did name 17 of them; the README says where.
```

**22/**

```text
Detection is worth less than prevention. A free, ownerless, view-only contract on Robinhood Chain returns the corrected share count or refuses with a reason. Tested by forking the chain, warping 3 days ahead, and watching it say no.
```

**23/**

```text
Two paid calls settle over x402 on Base: $0.01 for an audited position, $0.25 for a contract audit. The public MCP gives the verdicts free. ERC-8004 identity 8453:95374. 511 tests, 491 with no network, which CI runs on every push. [refresh]
```

**24/**

```text
An auditor that accuses someone who did it right is worse than no auditor.

https://assay-steel.vercel.app
https://github.com/OoJae/assay

Independent project; not affiliated with Robinhood or Chainlink. Not financial advice. @openservai
```

---

## 3. The form

<https://form.typeform.com/to/A475N331>. Fields in the form's order, with what to put in each.

| Field | Answer |
|---|---|
| Full name | yours |
| Email | the console.openserv.ai login (see the top of this file) |
| Track (select all that apply) | **Robinhood Chain / MCP**, the form's name for the page's *Mainnet & MCP* track. Never leave it blank. Add **Open Track** only if the organisers confirm in t.me/openservai that entries in two tracks are judged separately. Do not tick Coinbase AgentKit or IXS Vaults: the AgentKit provider is read-only and IXS is not used. |
| Your X submission link | the URL of the section 1 post, not a reply |
| Name of your project | `ASSAY` |
| Describe the project | the text below |
| Link to your project | **one URL**: <https://assay-steel.vercel.app> (the wall links the repo) |
| Additional links | **one URL**: the demo video |
| Logotype | a square PNG of the icon: `qlmanage -t -s 1024 -o . web/app/icon.svg` writes a 1024 × 1024 `icon.svg.png` |
| Did you enable data collection? | yes. It is on for the console org, and the SERV measurement runs are the usage it checks. |
| Team status | I'm joining solo |

**Describe the project** (about 190 words):

```
ASSAY is an independent valuation-integrity auditor for Stock Tokens on Robinhood Chain (chain 4663). Under ERC-8056 a corporate action moves uiMultiplier(), not balances, so balanceOf() is not a share count, and an agent that mixes on-chain token prices with off-chain share prices is wrong by the multiplier.

Who it is for: agents and integrators that value, collateralise or move Stock Token positions. It is the check they call first.

How it works: a sweep reads all 195 Stock Tokens every 8 minutes and publishes only findings whose every citation re-fetches byte-for-byte from chain state. The contracts holding the tokens are checked for uiMultiplier() and counted, never named. A free view-only guard contract on 4663 returns the corrected share count or refuses. The public MCP gives verdicts free; two paid x402 calls on Base sell the figures ($0.01 audited position, $0.25 contract audit). ERC-8004 identity 8453:95374.

Where SERV Reasoning runs: when a subject asks for an on-chain verdict about itself, SERV (gpt-5.6-luna-serv-kronos-multipath, with serv_prompt_guard and serv_shadow_agent) decides whether a verified finding is material against its declared mandate. No subject has requested one yet; the README publishes what we measured, including a null result.
```
