import Link from 'next/link'
import { loadSweep, SEV_RANK, symbolOf, snapshotAge, type Severity } from '@/lib/findings'

export const dynamic = 'force-dynamic'

const MCP_URL = 'https://sonar.my.id/assay-mcp/sse'
const REPO = 'https://github.com/OoJae/assay'
const SETTLED_TX = '0x270adb4cfb4daa2858be044cce510d41aa6a75f9f9c803036147d2ec5e7f50de'
const IDENTITY_TX = '0x976b21b288bd6edf7a4da3fe820d5fe0577cd95b416960637d3314af719a4b5a'
const ATTEST_TX = '0x5bed792da2865470c967173399c5b3f97148ef853d0346a920b13b8e7668e021'

function fmtAge(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${(s / 3600).toFixed(1)}h ago`
}

const REASON_COPY: Record<string, string> = {
  mismatch: 'A citation contradicted chain state. This is the only reason that impugns the finding.',
  unverifiable_here:
    'The RPC no longer serves that block. Unchecked, not disproven — Robinhood Chain produces ~100ms blocks and prunes state within minutes.',
  unchecked: 'The re-fetch failed after retries. Says nothing about the finding, only about our ability to confirm it.',
  no_evidence: 'The finding arrived with no citations at all — a defect in our detector, not a statement about the subject.',
}

export default function Home() {
  const d = loadSweep()
  const findings = [...d.findings].sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.subject.localeCompare(b.subject),
  )
  const totalCites = d.findings.reduce((n, f) => n + (f.verification?.checked ?? 0), 0)
  const okCites = d.findings.reduce((n, f) => n + (f.verification?.reproduced ?? 0), 0)
  const bySev = findings.reduce<Record<string, number>>((m, f) => {
    m[f.severity] = (m[f.severity] ?? 0) + 1
    return m
  }, {})
  const rejected = d.rejected ?? []
  const { fresh } = snapshotAge(d.observedAt)

  return (
    <div className="wrap">
      <nav className="navbar">
        <span className="brand">ASSAY</span>
        <Link href="/pricing">Pricing</Link>
        <a href={REPO}>Source</a>
        <a href="/agent-card.json">Agent card</a>
        <span className="spacer" />
        <a href={`https://basescan.org/tx/${SETTLED_TX}`}>x402 · $0.01 settled</a>
      </nav>

      <header className="top">
        <div className="tag">ASSAY · Robinhood Chain 4663 · ERC-8056 Stock Tokens</div>
        <h1>Every cited byte was re-fetched and compared.</h1>
        <p className="lede">
          Robinhood Stock Tokens implement <strong>ERC-8056</strong>: a corporate action moves{' '}
          <span className="mono">uiMultiplier()</span>, not balances. ASSAY sweeps the chain, reads
          the multiplier, the Chainlink feed and its heartbeat directly from state, and publishes
          only findings whose every citation reproduces byte-for-byte. It never moves capital and
          it has no control path over anything it grades.
        </p>
      </header>

      <div className="grid">
        <div className="stat">
          <div className="n">{d.findings.length}</div>
          <div className="k">published findings</div>
        </div>
        <div className="stat">
          <div className="n" style={{ color: 'var(--ok)' }}>
            {okCites}/{totalCites}
          </div>
          <div className="k">citations reproduced</div>
        </div>
        <div className="stat">
          <div className="n" style={{ color: rejected.length ? 'var(--med)' : undefined }}>
            {rejected.length}
          </div>
          <div className="k">withheld</div>
        </div>
        <div className="stat">
          <div className="n">{d.assetsScanned}</div>
          <div className="k">assets swept</div>
        </div>
        <div className="stat">
          <div className="n">
            {d.cohort.stale}/{d.cohort.size}
          </div>
          <div className="k">24/5 feeds stale</div>
        </div>
        <div className="stat">
          <div className="n" style={{ color: 'var(--crit)' }}>{bySev.critical ?? 0}</div>
          <div className="k">critical</div>
        </div>
      </div>

      <div className="banner">
        {fresh ? (
          <>
            Swept at block <span className="mono">{d.blockNumber}</span> ({fmtAge(d.observedAt)}).{' '}
            {d.marketClosed ? (
              <>
                <strong>US equity market is closed.</strong> {d.cohort.stale} of {d.cohort.size} 24/5
                feeds are stale at this same block, which corroborates a scheduled closure rather
                than an oracle incident — so those are reported as expected, not as failures. The
                defect is that <span className="mono">latestRoundData()</span> returns a price
                either way and gives callers no on-chain way to tell the difference.
              </>
            ) : (
              <>
                <strong>Market open.</strong> Staleness now is not explained by a scheduled closure.
              </>
            )}
          </>
        ) : (
          <>
            <span className="badge">STALE SNAPSHOT</span>{' '}
            Swept at block <span className="mono">{d.blockNumber}</span>, {fmtAge(d.observedAt)}.
            Market conditions below describe <strong>that moment, not now</strong>.{' '}
            {d.marketClosed ? (
              <>
                At that block the US equity market <strong>was closed</strong>: {d.cohort.stale} of{' '}
                {d.cohort.size} 24/5 feeds were stale, corroborating a scheduled closure rather than
                an oracle incident.
              </>
            ) : (
              <>
                At that block the market <strong>was open</strong>, so staleness then was not
                explained by a scheduled closure.
              </>
            )}{' '}
            Stating a live market condition from an old snapshot is the exact error this tool exists
            to catch, so the page declines to.
          </>
        )}
      </div>

      <div className="proofs">
        <div className="proof">
          <div className="lbl">Paid endpoint · x402</div>
          <div className="val">
            $0.01 · <a href={`https://basescan.org/tx/${SETTLED_TX}`}>settled on Base</a>
          </div>
        </div>
        <div className="proof">
          <div className="lbl">MCP (SSE)</div>
          <div className="val">{MCP_URL}</div>
        </div>
        <div className="proof">
          <div className="lbl">ERC-8004 identity</div>
          <div className="val">
            <a href={`https://basescan.org/tx/${IDENTITY_TX}`}>8453:95265</a>
          </div>
        </div>
        <div className="proof">
          <div className="lbl">Self-attestation</div>
          <div className="val">
            <a href={`https://basescan.org/tx/${ATTEST_TX}`}>ValidationRegistry</a>
          </div>
        </div>
      </div>

      {d.chainNotes.map((n) => (
        <div className="banner" key={n.id} style={{ borderColor: 'var(--high)' }}>
          <span className={`sev ${n.severity}`}>{n.severity}</span>{' '}
          <strong>{n.title}</strong>
          <div style={{ marginTop: 8 }}>{n.statement}</div>
          <div className="meta" style={{ marginTop: 8 }}>
            No on-chain citation is possible for an absence, so this is reported separately from
            findings and never inherits the byte-verified guarantee.
          </div>
        </div>
      ))}

      <div className="tscroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 84 }}>Severity</th>
              <th style={{ width: 74 }}>Asset read</th>
              <th>Finding</th>
              <th style={{ width: 210 }}>Class</th>
              <th style={{ width: 96 }}>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f) => (
              <tr key={f.id}>
                <td>
                  <span className={`sev ${f.severity}`}>{f.severity}</span>
                </td>
                <td className="sym">{symbolOf(f.subject)}</td>
                <td>
                  <Link href={`/f/${encodeURIComponent(f.id)}`} style={{ textDecoration: 'none' }}>
                    {f.title}
                  </Link>
                </td>
                <td className="cls">{f.defectClass}</td>
                <td className="verified">
                  {f.verification?.reproduced ?? 0}/{f.verification?.checked ?? 0} ✓
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="sub" style={{ marginTop: 10 }}>
        <strong>Asset read</strong> names the contract whose state was read. It is not an accusation
        against that contract — a Stock Token that moves <span className="mono">uiMultiplier()</span>{' '}
        is doing exactly what ERC-8056 specifies. The exposure lands on an integrator that reads{' '}
        <span className="mono">balanceOf()</span> as a share count.
      </p>

      {findings.length === 0 && (
        <div className="card">
          No sweep data yet. Run <span className="mono">pnpm sweep</span> in the project root.
        </div>
      )}

      <h2 className="h2">Withheld this sweep — {rejected.length}</h2>
      <p className="sub">
        Findings the detector produced and the verifier refused to publish. They are shown because a
        verification claim is only worth anything if the misses are visible too, and because{' '}
        <em>could not check</em> and <em>is false</em> are different statements that most tools
        collapse into silence. Only <span className="mono">mismatch</span> impugns a finding; the
        rest record the limits of what this RPC could confirm.
      </p>

      {rejected.length === 0 ? (
        <div className="card">
          <strong>Nothing was withheld at block {d.blockNumber}.</strong>
          <div className="sub" style={{ marginTop: 8 }}>
            All {totalCites} citations across {d.findings.length} findings re-fetched and matched
            byte-for-byte. Earlier sweeps withheld up to 11 at a time — the cause was the RPC pruning
            state faster than a 12-minute sweep could finish, which is why verification now runs
            inline at each asset&apos;s own block rather than as a later pass.
          </div>
        </div>
      ) : (
        <div className="tscroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>Reason</th>
                <th style={{ width: 74 }}>Asset read</th>
                <th>Finding</th>
                <th>Why it was withheld</th>
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
                  <td className="sub" style={{ margin: 0 }}>
                    {r.detail}
                    <div className="meta" style={{ marginTop: 6 }}>
                      {REASON_COPY[r.reason] ?? ''}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer>
        ASSAY publishes facts and raw return bytes in neutral engineering language. It does not
        assert intent and never uses the word fraud. Unsolicited findings are never written
        on-chain; only a verdict a subject requested is. Any named party may have their reply
        published alongside a finding — open an issue at{' '}
        <a href={`${REPO}/issues`}>{REPO.replace('https://', '')}</a> or write to the address in{' '}
        <a href={`${REPO}/blob/main/README.md`}>the README</a>, and it is attached unedited.
        Methodology is versioned so any subject can reproduce their own grade. A subject&apos;s own
        declared mandate text is sent to OpenServ&apos;s inference API when a solicited verdict is
        adjudicated, under this account&apos;s data-collection setting. Pre-publication notice is
        deliberately not claimed: the sweep publishes on a timer, and for most findings the subject
        is a contract rather than a person to notify. ASSAY rates itself first, and its own
        self-attestation says on its face that it carries no independent assurance.
      </footer>
    </div>
  )
}
