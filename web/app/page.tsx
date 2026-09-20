import Link from 'next/link'
import { loadSweep, SEV_RANK, symbolOf, type Severity } from '@/lib/findings'

export const dynamic = 'force-dynamic'

function fmtAge(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${(s / 3600).toFixed(1)}h ago`
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

  return (
    <div className="wrap">
      <header className="top">
        <div className="tag">ASSAY · Robinhood Chain 4663 · IXS RWA vaults</div>
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
        Swept at block <span className="mono">{d.blockNumber}</span> ({fmtAge(d.observedAt)}).{' '}
        {d.marketClosed ? (
          <>
            <strong>US equity market is closed.</strong> {d.cohort.stale} of {d.cohort.size} 24/5
            feeds are stale at this same block, which corroborates a scheduled closure rather than
            an oracle incident — so those are reported as expected, not as failures. The defect is
            that <span className="mono">latestRoundData()</span> returns a price either way and
            gives callers no on-chain way to tell the difference.
          </>
        ) : (
          <>
            <strong>Market open.</strong> Staleness now is not explained by a scheduled closure.
          </>
        )}
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

      <table>
        <thead>
          <tr>
            <th style={{ width: 84 }}>Severity</th>
            <th style={{ width: 74 }}>Asset</th>
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

      {findings.length === 0 && (
        <div className="card">
          No sweep data yet. Run <span className="mono">pnpm sweep</span> in the project root.
        </div>
      )}

      <footer>
        ASSAY publishes facts and raw return bytes in neutral engineering language. It does not
        assert intent and never uses the word fraud. Unsolicited findings are never written
        on-chain; only a verdict a subject requested is. Methodology is versioned so any subject can
        reproduce their own grade. ASSAY rates itself first.
      </footer>
    </div>
  )
}
