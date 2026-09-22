import Link from 'next/link'
import { notFound } from 'next/navigation'
import { loadSweepLive, repliesFor } from '@/lib/findings'

export const dynamic = 'force-dynamic'

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const d = await loadSweepLive()
  const f = d.findings.find((x) => x.id === decodeURIComponent(id))
  if (!f) notFound()
  const replies = repliesFor(f.id)

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
          read from {f.subject} · methodology {f.methodologyVersion} · detected {f.detectedAt}
        </div>
        {f.affectedParty ? (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="tag">Who carries the exposure</div>
            <div style={{ marginTop: 8, lineHeight: 1.7, fontSize: 14 }}>{f.affectedParty}</div>
            <div className="meta" style={{ marginTop: 10 }}>
              The contract named above is what was READ. Naming it is not an accusation against it:
              a Stock Token that moves uiMultiplier() is doing what ERC-8056 specifies.
            </div>
          </div>
        ) : null}
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

      {f.offChainSources?.length ? (
        <div className="card" style={{ borderColor: 'var(--high)' }}>
          <div className="tag">Off-chain inputs — NOT covered by the byte-verified guarantee</div>
          <div className="meta" style={{ marginTop: 8, marginBottom: 10 }}>
            The citations above are re-fetched from chain state and byte-compared. The values below
            cannot be, because they do not live on chain. They are listed so you can tell the
            difference.
          </div>
          {f.offChainSources.map((o, i) => (
            <div className="ev" key={i}>
              <div className="claim">{o.describes}</div>
              <div className="meta">
                fetched {o.fetchedAt}
                <br />
                <a href={o.url} target="_blank" rel="noreferrer">{o.url}</a>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {replies.length ? (
        <div className="card" style={{ borderColor: 'var(--low)' }}>
          <div className="tag">Reply from a named party — published verbatim</div>
          {replies.map((r, i) => (
            <div className="ev" key={i} style={{ borderLeftColor: 'var(--low)' }}>
              <div className="claim">{r.from}</div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 14, margin: '8px 0' }}>
                {r.text}
              </div>
              <div className="meta">
                received {r.receivedAt} · published {r.publishedAt}
                {r.outcome ? ` · outcome: ${r.outcome}` : ''}
                {r.sourceUrl ? (
                  <>
                    <br />
                    <a href={r.sourceUrl} target="_blank" rel="noreferrer">{r.sourceUrl}</a>
                  </>
                ) : null}
              </div>
              {r.assayResponse ? (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
                  <div className="tag">ASSAY&apos;s response — not part of the reply above</div>
                  <div style={{ marginTop: 8, lineHeight: 1.7, fontSize: 14 }}>{r.assayResponse}</div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <div className="tag">Right of reply</div>
          <div className="meta" style={{ marginTop: 8, lineHeight: 1.8 }}>
            No reply has been received for this finding. Anyone named here can have a response
            published <strong>verbatim and unedited</strong> alongside it, and any finding shown to
            be wrong is corrected or withdrawn.{' '}
            <a href="https://github.com/OoJae/assay/issues/new?template=right-of-reply.md">
              Open a right-of-reply issue
            </a>{' '}
            or see{' '}
            <a href="https://github.com/OoJae/assay/blob/main/docs/RIGHT-OF-REPLY.md">
              docs/RIGHT-OF-REPLY.md
            </a>
            . Pre-publication notice is deliberately <em>not</em> claimed: the sweep publishes on a
            timer and for most findings the subject is a contract, not a person to notify.
          </div>
        </div>
      )}

      <footer>
        Reproduce this yourself:
        <pre style={{ marginTop: 10 }}>{`cast call ${f.evidence[0]?.contract ?? ''} "${
          f.evidence[0]?.call ?? ''
        }" \\
  --block ${f.evidence[0]?.blockNumber ?? ''} \\
  --rpc-url https://rpc.mainnet.chain.robinhood.com`}</pre>
        Note: the public RPC serves state for 5,000–10,000 blocks at 0.101s each — measured, not
        estimated — so a citation stops being re-fetchable 8 to 17 minutes after it is minted. An
        older block may no
        longer be served. That makes a citation unchecked here, not disproven — ASSAY reports those
        two cases separately and never publishes a finding whose citation contradicts chain state.
      </footer>
    </div>
  )
}
