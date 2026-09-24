import Link from 'next/link'
import { divergentTokens, loadSweepLive, snapshotAge, symbolOf, unreadAssets } from '@/lib/findings'
import { PAID_ENDPOINTS } from '@/lib/endpoints'
import { closureBasis, fmtAge, splitBySeverity } from '@/lib/present'
import { OWNER, REPO, RIGHT_OF_REPLY_DOC, RIGHT_OF_REPLY_ISSUE } from '@/lib/site'
import { GUARD_ADDRESS } from '@/lib/guard'
import { CheckWallet } from '../_components/check-wallet'
import { FindingsTable } from '../_components/findings-table'
import { IntegratorPanel } from '../_components/integrators'
import { ServReasoning } from '../_components/serv-reasoning'
import { UseIt } from '../_components/use-it'
import { Reveal } from '../_motion/reveal'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Findings wall' }

const IDENTITY_TX = '0x019ecbbcfe12f646d977c3a7d778d147d91cac9d6a348cc93a03be6d80e8356f'
/** Settled to 0x6328…7911, the current payTo. */
const CONTRACT_AUDIT_TX = '0xc192e7b94cdd9b1ae4c77e4602f3fad75067b96b19fd24c6d5d2441a4febc3b2'
/**
 * Settled to the 95265 wallet, whose signing key was lost. It stays true and verifiable, but shown
 * unlabelled beside 95374 it read as the current identity's, and a judge clicking through found a
 * different agent id and wallet.
 */
const SETTLED_TX_95265 = '0x50124847a9228521b829e3b47a2b098f5688e57d147e33764232c4c8f686b96b'
/** The self-attestation re-issued under 95374; the one under 95265 stays on-chain as history. */
const ATTEST_TX_95374 = '0x885d978810fbfccace75db1116897791483624c6ac68573fce96ef7a4dcaf1ee'
const ATTEST_DOC_95374 = '/attestations/95374/0x8e9f35901bb72c4efb62d6818a14d644c523513d5ba117ed4fc8e9296ff21aeb.json'

const REASON_COPY: Record<string, string> = {
  mismatch: 'A citation contradicted chain state. This is the only reason that impugns the finding.',
  unverifiable_here:
    'The RPC no longer serves that block. Unchecked, not disproven — Robinhood Chain produces ~100ms blocks and prunes state within minutes.',
  unchecked: 'The re-fetch failed after retries. Says nothing about the finding, only about our ability to confirm it.',
  no_evidence: 'The finding arrived with no citations at all — a defect in our detector, not a statement about the subject.',
}

export default async function Home() {
  const d = await loadSweepLive()
  const { lead, minor } = splitBySeverity(d.findings)
  const totalCites = d.findings.reduce((n, f) => n + (f.verification?.checked ?? 0), 0)
  const okCites = d.findings.reduce((n, f) => n + (f.verification?.reproduced ?? 0), 0)
  const critical = d.findings.filter((f) => f.severity === 'critical').length
  const rejected = d.rejected ?? []
  const unread = unreadAssets(d)
  const { fresh } = snapshotAge(d.observedAt)
  const cohortRead = d.cohort.read ?? d.cohort.size
  const basis = closureBasis(d.cohort)
  // The largest share-count gap on the board, quoted by its own title rather than re-derived.
  const worst = d.findings
    .filter((f) => f.defectClass === 'SHARE_COUNT_MISREAD_RISK')
    .sort((a, b) => (b.impact.percent ?? 0) - (a.impact.percent ?? 0))[0]
  const tp = PAID_ENDPOINTS.truePosition
  const cc = PAID_ENDPOINTS.checkContract

  return (
    <>
      <main id="main" className="wrap">
        <header className="top">
          <div className="tag">ASSAY · independent valuation-integrity audit · Stock Tokens on chain 4663</div>
          <h1 className="page-title">balanceOf() is not a share count.</h1>
          <p className="lede">
            Stock Tokens on Robinhood Chain implement <strong>ERC-8056</strong>: a corporate action moves{' '}
            <span className="mono">uiMultiplier()</span>, not balances, so the share count is{' '}
            <span className="mono">balance × uiMultiplier() / 1e18</span>.{' '}
            {worst ? (
              <>
                The largest gap on the board{fresh ? ' right now' : ` at block ${d.blockNumber}`}:{' '}
                <Link href={`/f/${encodeURIComponent(worst.id)}`}>{worst.title}</Link>.{' '}
              </>
            ) : null}
            ASSAY sweeps every Stock Token every 8 minutes, reads the multiplier, the Chainlink feed and its
            heartbeat from chain state, and publishes only findings whose every citation re-fetches
            byte-for-byte. It never moves capital and has no control path over anything it grades.
          </p>
          <div className="actions">
            <a className="btn primary" href="#check">
              Check a wallet · free
            </a>
            <a className="btn" href={tp.paywall}>
              Audited position · ${tp.priceUsd.toFixed(2)}
            </a>
            <a className="btn" href={cc.paywall}>
              Audit a contract · ${cc.priceUsd.toFixed(2)}
            </a>
            <a className="btn" href="#use-it">
              Call it from code
            </a>
          </div>
        </header>

        <div className="grid">
          <div className="stat">
            <div className="n">{d.findings.length}</div>
            <div className="k">published findings</div>
          </div>
          <div className="stat">
            <div className={totalCites > 0 && okCites === totalCites ? 'n n--streak' : 'n'}>
              {okCites}/{totalCites}
            </div>
            <div className="k">citations reproduced</div>
          </div>
          <div className="stat">
            <div className={rejected.length ? 'n n--aqua' : 'n'}>
              {rejected.length}
            </div>
            <div className="k">withheld by the verifier</div>
          </div>
          <div className="stat">
            {/* assetsScanned counts assets ATTEMPTED. An asset the RPC refused is not assessed, and
                counting it as swept is the unread-counted-as-clean error. */}
            <div className={unread.length ? 'n n--aqua' : 'n'}>
              {unread.length ? `${Math.max(0, d.assetsScanned - unread.length)}/${d.assetsScanned}` : d.assetsScanned}
            </div>
            <div className="k">{unread.length ? `assets read · ${unread.length} not assessed` : 'assets read'}</div>
          </div>
          <div className="stat">
            <div className="n">
              {d.cohort.stale}
              <span className="of"> of {cohortRead}</span>
            </div>
            <div className="k">
              {/* Denominator is feeds READ, not the cohort size. Printing stale/size re-presents a
                  failed RPC read as a fresh feed — the exact defect the sweeper was fixed for. */}
              24/5 feeds stale
              {d.cohort.failed ? ` · ${d.cohort.failed} unread` : ''}
            </div>
          </div>
          <div className="stat">
            <div className={critical ? 'n n--aqua' : 'n'}>{critical}</div>
            <div className="k">critical</div>
          </div>
        </div>

        <div className="banner" role="status">
          {d.source === 'committed' ? (
            <>
              <span className="badge">LIVE FEED UNREACHABLE</span> This page is showing the snapshot
              committed with this deployment, not the current sweep.{' '}
            </>
          ) : null}
          {fresh ? (
            <>
              Swept at block <span className="mono">{d.blockNumber}</span> ({fmtAge(d.observedAt)}).{' '}
              {d.cohort.quorum === false ? (
                <>
                  <strong>Market state undetermined.</strong> Only {d.cohort.read ?? 0} of{' '}
                  {d.cohort.size} 24/5 equity feeds could be read at this block, below the 80% quorum
                  this methodology requires before drawing any market-wide conclusion. Staleness found
                  here is reported without a cause, because we could not measure one.
                </>
              ) : d.marketClosed ? (
                basis === 'cohort' ? (
                  <>
                    <strong>The 24/5 equity session is closed.</strong> {d.cohort.stale} of the{' '}
                    {cohortRead} 24/5 feeds that could be read are stale, which corroborates a scheduled
                    closure rather than an oracle incident — so those are reported as expected, not as
                    failures. The defect is that <span className="mono">latestRoundData()</span> returns a
                    price either way and gives callers no on-chain way to tell the difference.
                  </>
                ) : (
                  <>
                    <strong>The 24/5 equity session is closed</strong> by its published schedule (Friday
                    20:00 to Sunday 20:00, New York time); {d.cohort.stale} of {cohortRead} feeds are past
                    their heartbeat so far. <span className="mono">latestRoundData()</span> returns a price
                    either way and gives callers no on-chain way to tell a closure from an incident.
                  </>
                )
              ) : d.cohort.stale === 0 ? (
                <>
                  <strong>The 24/5 equity session is open</strong> and no 24/5 feed is past its heartbeat.
                </>
              ) : (
                <>
                  <strong>The 24/5 equity session is open</strong>, so the {d.cohort.stale} stale{' '}
                  {d.cohort.stale === 1 ? 'feed is' : 'feeds are'} not explained by a scheduled closure.
                </>
              )}
            </>
          ) : (
            <>
              <span className="badge">STALE SNAPSHOT</span> Swept at block{' '}
              <span className="mono">{d.blockNumber}</span>, {fmtAge(d.observedAt)}. Market conditions
              below describe <strong>that moment, not now</strong>.{' '}
              {d.cohort.quorum === false ? (
                <>
                  At that block the market state was <strong>undetermined</strong>: only{' '}
                  {d.cohort.read ?? 0} of {d.cohort.size} 24/5 feeds could be read, below the quorum
                  needed to draw a conclusion.
                </>
              ) : d.marketClosed ? (
                <>
                  At that block the 24/5 equity session <strong>was closed</strong>
                  {basis === 'cohort'
                    ? `: ${d.cohort.stale} of the ${cohortRead} feeds read were stale, corroborating a scheduled closure rather than an oracle incident.`
                    : ` by its published schedule, with ${d.cohort.stale} of ${cohortRead} feeds past their heartbeat.`}
                </>
              ) : (
                <>
                  At that block the 24/5 equity session <strong>was open</strong>, so staleness then was not
                  explained by a scheduled closure.
                </>
              )}{' '}
              Stating a live market condition from an old snapshot is the exact error this tool exists
              to catch, so the page declines to.
            </>
          )}
        </div>

        {unread.length ? (
          <div className="banner banner--aqua">
            <strong>
              {unread.length} {unread.length === 1 ? 'asset' : 'assets'} could not be read this sweep and{' '}
              {unread.length === 1 ? 'is' : 'are'} not assessed:
            </strong>{' '}
            <span className="mono">{unread.join(' ')}</span>. No finding about{' '}
            {unread.length === 1 ? 'it' : 'them'} is published, and absence from the table is not a clean
            result.
          </div>
        ) : null}

        <section id="check" className="ledger" aria-labelledby="check-h">
          <Reveal as="h2" className="h2" id="check-h">
            Check a wallet
          </Reveal>
          <p className="sub">
            Paste any address to see <span className="mono">balanceOf()</span> next to its share-equivalents
            for every Stock Token whose multiplier is not 1, as the on-chain ERC8056Guard reports them,
            refusals included.
          </p>
          <CheckWallet tokens={divergentTokens(d)} />
        </section>

        {d.integrators && d.integrators.contracts > 0 ? (
          <section className="ledger" aria-labelledby="exposure">
            <Reveal as="h2" className="h2" id="exposure">
              Who holds the exposure
            </Reveal>
            <IntegratorPanel agg={d.integrators} namedWithheld={d.withheld?.namedIntegrators} />
          </section>
        ) : null}

        <section className="ledger" aria-labelledby="findings-h">
          <Reveal as="h2" className="h2" id="findings-h">
            Findings — {d.findings.length}
          </Reveal>
          {d.findings.length === 0 ? (
            <div className="card">
              The sweep feed is temporarily unavailable and no snapshot could be loaded, so there are no
              findings to show. Nothing here should be read as a clean result.
            </div>
          ) : (
            <>
              <FindingsTable findings={lead} caption="Critical, high and medium findings, most severe first" />
              {minor.length ? (
                <details className="fold">
                  <summary>
                    Show {minor.length} low-severity {minor.length === 1 ? 'finding' : 'findings'}
                  </summary>
                  <FindingsTable findings={minor} caption="Low-severity findings" />
                </details>
              ) : null}
              <p className="sub">
                <strong>Asset read</strong> names the contract whose state was read. It is not an accusation
                against that contract — a Stock Token that moves <span className="mono">uiMultiplier()</span>{' '}
                is doing exactly what ERC-8056 specifies. The exposure lands on an integrator that reads{' '}
                <span className="mono">balanceOf()</span> as a share count.
              </p>
            </>
          )}
        </section>

        <UseIt missingFeeds={d.stats?.missingFeeds} assetsScanned={d.assetsScanned} />

        <ServReasoning />

        {d.chainNotes.length ? (
          <section className="ledger" aria-labelledby="notes-h">
            <Reveal as="h2" className="h2" id="notes-h">
              Chain notes
            </Reveal>
            {d.chainNotes.map((n) => (
              <div className="banner" key={n.id}>
                <span className={`sev ${n.severity}`}>{n.severity}</span> <strong>{n.title}</strong>
                <div className="banner__body">{n.statement}</div>
                <div className="note">
                  No on-chain citation is possible for an absence, so this is reported separately from
                  findings and never inherits the byte-verified guarantee.
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <section className="ledger" aria-labelledby="proofs-h">
          <Reveal as="h2" className="h2" id="proofs-h">
            On-chain proofs
          </Reveal>
          <div className="proofs">
            <div className="proof">
              <div className="lbl">ERC-8004 identity</div>
              <div className="val">
                <a href={`https://basescan.org/tx/${IDENTITY_TX}`}>8453:95374</a>
              </div>
            </div>
            <div className="proof">
              <div className="lbl">Contract audit · x402</div>
              <div className="val">
                $0.25 · <a href={`https://basescan.org/tx/${CONTRACT_AUDIT_TX}`}>settled on Base</a> to{' '}
                {OWNER.slice(0, 6)}…{OWNER.slice(-4)}
              </div>
            </div>
            <div className="proof">
              <div className="lbl">Guard on 4663 · free</div>
              <div className="val">
                <a href={`https://sourcify.dev/#/lookup/${GUARD_ADDRESS}`}>ERC8056Guard</a> · verified
              </div>
            </div>
            <div className="proof">
              <div className="lbl">Position check · x402 · under frozen 95265</div>
              <div className="val">
                $0.01 · <a href={`https://basescan.org/tx/${SETTLED_TX_95265}`}>settled on Base</a> to the
                95265 wallet, whose key is lost
              </div>
            </div>
            <div className="proof">
              <div className="lbl">Self-attestation · 8453:95374 · self-issued</div>
              <div className="val">
                <a href={`https://basescan.org/tx/${ATTEST_TX_95374}`}>ValidationRegistry</a> ·{' '}
                <a href={ATTEST_DOC_95374}>document</a> · <a href={`${REPO}#on-chain-proofs`}>earlier one under 95265</a>
              </div>
            </div>
          </div>
        </section>

        <section className="ledger" aria-labelledby="withheld-h">
          <Reveal as="h2" className="h2" id="withheld-h">
            Withheld by the verifier — {rejected.length}
          </Reveal>
          <p className="sub">
            Findings the detector produced and the verifier refused to publish. They are shown because a
            verification claim is only worth anything if the misses are visible too, and because{' '}
            <em>could not check</em> and <em>is false</em> are different statements that most tools
            collapse into silence. Only <span className="mono">mismatch</span> impugns a finding; the
            rest record the limits of what this RPC could confirm.
          </p>
          {/* A second kind of withholding, by policy rather than verification, and counted apart so the
              heading's number cannot read as "nothing was withheld" next to the integrator panel's. */}
          {(d.withheld?.namedIntegrators ?? 0) > 0 ? (
            <p className="sub">
              Separately, {d.withheld!.namedIntegrators} verified findings that would name a holder contract are
              withheld from this site by policy: they are counted in the integrator panel above, and the $0.25
              contract audit answers for an address you supply.
            </p>
          ) : null}

          {rejected.length === 0 ? (
            <div className="card">
              <strong>The verifier withheld nothing at block {d.blockNumber}.</strong>
              <div className="sub">
                All {totalCites} citations across {d.findings.length} findings re-fetched and matched
                byte-for-byte. Earlier sweeps withheld up to 11 at a time — the cause was the RPC pruning
                state faster than a 12-minute sweep could finish, which is why verification now runs
                inline at each asset&apos;s own block rather than as a later pass.
              </div>
            </div>
          ) : (
            <div className="tscroll">
              <table className="table--wide">
                <caption className="sr-only">Findings the verifier withheld, with the reason</caption>
                <thead>
                  <tr>
                    <th scope="col" className="col-rsn">
                      Reason
                    </th>
                    <th scope="col" className="col-sym">
                      Asset read
                    </th>
                    <th scope="col">Finding</th>
                    <th scope="col">Why it was withheld</th>
                  </tr>
                </thead>
                <tbody>
                  {rejected.map((r, i) => (
                    <tr className="withheld" key={`${r.finding.id}-${i}`}>
                      <td>
                        <span className={`rsn ${r.reason}`}>{r.reason.replace(/_/g, ' ')}</span>
                      </td>
                      <td className="sym">{symbolOf(r.finding.subject)}</td>
                      <td>{r.finding.title ?? r.finding.id}</td>
                      <td className="sub">
                        {r.detail}
                        <div className="meta">
                          {REASON_COPY[r.reason] ?? ''}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer>
          ASSAY publishes facts and raw return bytes in neutral engineering language. It does not
          assert intent and never uses the word fraud. Unsolicited findings are never written
          on-chain; only a verdict a subject requested is. Any named party may have their reply
          published alongside a finding, unedited: see <a href={RIGHT_OF_REPLY_DOC}>docs/RIGHT-OF-REPLY.md</a>,{' '}
          or <a href={RIGHT_OF_REPLY_ISSUE}>open a right-of-reply issue</a>. Identity 8453:95374 is owned by{' '}
          <span className="mono">{OWNER}</span>. Methodology is
          versioned, so a subject can inspect the exact rules its grade was produced under. A
          subject&apos;s own declared mandate text is sent to OpenServ&apos;s inference API when a
          solicited verdict is adjudicated, and training-data collection is on for this account, so OpenServ
          may retain that text for up to five years.
          Pre-publication notice is deliberately not claimed: the sweep publishes on a timer, and for most
          findings the subject is a contract rather than a person to notify. ASSAY rates itself first, and
          its own self-attestation says on its face that it carries no independent assurance.
        </footer>
      </main>
    </>
  )
}
