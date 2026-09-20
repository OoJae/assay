import Link from 'next/link'
import { notFound } from 'next/navigation'
import { loadSweep } from '@/lib/findings'

export const dynamic = 'force-dynamic'

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const d = loadSweep()
  const f = d.findings.find((x) => x.id === decodeURIComponent(id))
  if (!f) notFound()

  return (
    <div className="wrap">
      <Link className="back" href="/">
        ← all findings
      </Link>

      <header className="top" style={{ marginTop: 18 }}>
        <div className="tag">
          <span className={`sev ${f.severity}`}>{f.severity}</span>{' '}
          <span style={{ marginLeft: 8 }}>{f.defectClass}</span>
        </div>
        <h1 style={{ fontSize: 24, marginTop: 12 }}>{f.title}</h1>
        <div className="meta" style={{ marginTop: 8 }}>
          subject {f.subject} · methodology {f.methodologyVersion} · detected {f.detectedAt}
        </div>
      </header>

      <div className="card">
        <p style={{ margin: 0, lineHeight: 1.75, fontSize: 14.5 }}>{f.statement}</p>
      </div>

      <div className="card">
        <div className="tag">Impact</div>
        <div style={{ marginTop: 10, lineHeight: 1.7, fontSize: 14 }}>
          {f.impact.basisPoints !== undefined && (
            <div className="mono" style={{ fontSize: 18, marginBottom: 6 }}>
              {f.impact.basisPoints.toLocaleString()} bps
              {f.impact.percent !== undefined && ` · ${f.impact.percent}%`}
            </div>
          )}
          <div style={{ color: 'var(--muted)' }}>{f.impact.note}</div>
        </div>
      </div>

      <div className="card">
        <div className="tag">
          Evidence — {f.verification?.reproduced ?? 0}/{f.verification?.checked ?? 0} citations
          re-fetched and byte-compared
        </div>
        <div className="meta" style={{ marginTop: 8, marginBottom: 4 }}>
          mismatched {f.verification?.mismatched ?? 0} · pruned {f.verification?.pruned ?? 0} ·
          verified {f.verification?.verifiedAt}
        </div>
        {f.evidence.map((e, i) => (
          <div className="ev" key={i}>
            <div className="claim">{e.claim}</div>
            <div className="meta">
              chain {e.chainId} · block {e.blockNumber} · {e.call}
              <br />
              <a href={e.explorerUrl} target="_blank" rel="noreferrer">
                {e.contract}
              </a>
            </div>
            <pre>{e.rawReturn}</pre>
          </div>
        ))}
      </div>

      <footer>
        Reproduce this yourself:
        <pre style={{ marginTop: 10 }}>{`cast call ${f.evidence[0]?.contract ?? ''} "${
          f.evidence[0]?.call ?? ''
        }" \\
  --block ${f.evidence[0]?.blockNumber ?? ''} \\
  --rpc-url https://rpc.mainnet.chain.robinhood.com`}</pre>
        Note: the public RPC prunes state within roughly 1k–10k blocks, so an older block may no
        longer be served. That makes a citation unchecked here, not disproven — ASSAY reports those
        two cases separately and never publishes a finding whose citation contradicts chain state.
      </footer>
    </div>
  )
}
