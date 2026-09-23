import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  CITATION_RETENTION_MS,
  isWithheldFindingId,
  loadSweepLive,
  repliesFor,
  snapshotAge,
  type Evidence,
} from '@/lib/findings'
import { PAID_ENDPOINTS } from '@/lib/endpoints'
import { fmtAge, impactView } from '@/lib/present'
import { OG_IMAGE, RIGHT_OF_REPLY_DOC, RIGHT_OF_REPLY_ISSUE } from '@/lib/site'
import { RH_RPC_URL } from '@/lib/guard'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * A finding's own title and impact, so a shared link unfurls as that finding rather than as the
 * site. Every finding page used to share the home page's title and card.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  if (isWithheldFindingId(decodeURIComponent(id))) return { title: 'Withheld' }
  const d = await loadSweepLive()
  const f = d.findings.find((x) => x.id === decodeURIComponent(id))
  if (!f) return { title: 'Finding not found' }
  const description = f.impact.note.length > 200 ? `${f.impact.note.slice(0, 197)}…` : f.impact.note
  return {
    title: f.title,
    description,
    openGraph: {
      type: 'article',
      siteName: 'ASSAY',
      url: `/f/${encodeURIComponent(f.id)}`,
      title: f.title,
      description,
      images: [OG_IMAGE],
    },
    twitter: { card: 'summary_large_image', title: f.title, description, images: [OG_IMAGE.url] },
  }
}

/** One command per citation; a call with arguments is re-run from its exact calldata. */
function castFor(e: Evidence): string {
  const target = e.calldata ? `${e.contract} --data ${e.calldata}` : `${e.contract} "${e.call}"`
  return `cast call ${target} \\\n  --block ${e.blockNumber} --rpc-url ${RH_RPC_URL}`
}

/** A finding that would name a holder contract: withheld from this site, and said so. */
function Withheld() {
  const cc = PAID_ENDPOINTS.checkContract
  return (
    <>
      <nav className="navbar" aria-label="Site">
        <span className="brand">ASSAY</span>
        <Link href="/">← All findings</Link>
        <Link href="/pricing">Pricing</Link>
      </nav>
      <main>
        <header className="top">
          <div className="tag">Withheld</div>
          <h1>Findings that name a holder contract are not published here.</h1>
          <p className="lede">
            This id has the shape of a finding that names a contract holding Stock Tokens without a{' '}
            <span className="mono">uiMultiplier()</span> reference. That verdict establishes the absence of
            a call, not the presence of a mistake, so no such contract is named on this site: they are
            counted, as an aggregate, in the integrator panel on the findings wall. This page is the same for
            every id of this shape and says nothing about whether one exists. The ${cc.priceUsd.toFixed(2)}{' '}
            <span className="mono">{cc.capability}</span> call answers for an address you supply.
          </p>
        </header>
        <div className="card">
          <a href={cc.paywall}>Audit a contract · ${cc.priceUsd.toFixed(2)}</a> ·{' '}
          <Link href="/">← Back to the findings wall</Link>
        </div>
      </main>
    </>
  )
}

export default async function FindingPage({ params }: Params) {
  const { id } = await params
  if (isWithheldFindingId(decodeURIComponent(id))) return <Withheld />
  const d = await loadSweepLive()
  const f = d.findings.find((x) => x.id === decodeURIComponent(id))
  if (!f) notFound()
  const replies = repliesFor(f.id)
  const { fresh } = snapshotAge(d.observedAt)
  const citedAt = f.evidence[0]?.observedAt ?? f.detectedAt
  const citedMs = Date.now() - new Date(citedAt).getTime()
  // An unknown age is treated as expired: promising a command works is the claim to be careful with.
  const retained = Number.isFinite(citedMs) && citedMs >= 0 && citedMs < CITATION_RETENTION_MS
  const impact = impactView(f)

  return (
    <>
      <nav className="navbar" aria-label="Site">
        <span className="brand">ASSAY</span>
        <Link href="/">← All findings</Link>
        <Link href="/pricing">Pricing</Link>
      </nav>

      <main>
        <header className="top" style={{ marginTop: 18 }}>
          <div className="tag">
            <span className={`sev ${f.severity}`}>{f.severity}</span>{' '}
            <span style={{ marginLeft: 8 }}>{f.defectClass}</span>
          </div>
          <h1 style={{ fontSize: 24, marginTop: 12 }}>{f.title}</h1>
          <div className="meta" style={{ marginTop: 8 }}>
            read from {f.subject} · methodology {f.methodologyVersion} · detected {f.detectedAt}
          </div>
          <div className="meta">
            {d.source === 'committed' ? <span className="badge">LIVE FEED UNREACHABLE</span> : null}{' '}
            {fresh ? null : <span className="badge">STALE SNAPSHOT</span>} from the sweep at block{' '}
            {d.blockNumber}, {fmtAge(d.observedAt)}
            {fresh ? '' : '; this condition may have changed since'}
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

        <section className="card" aria-labelledby="impact-h">
          <h2 className="tag" id="impact-h">
            Impact
          </h2>
          <div style={{ marginTop: 10, lineHeight: 1.7, fontSize: 14 }}>
            {impact.figure ? (
              <div style={{ marginBottom: 6 }}>
                <span className="mono" style={{ fontSize: 18 }}>
                  {impact.figure}
                </span>
                {impact.measures ? <span className="meta"> · {impact.measures}</span> : null}
              </div>
            ) : null}
            <div style={{ color: 'var(--muted)' }}>{f.impact.note}</div>
          </div>
        </section>

        <section className="card" aria-labelledby="evidence-h">
          <h2 className="tag" id="evidence-h">
            Evidence — {f.verification?.reproduced ?? 0}/{f.verification?.checked ?? 0} citations
            re-fetched and byte-compared
          </h2>
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
        </section>

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
              published <strong>verbatim and unedited</strong> alongside it. A finding shown to be wrong
              is corrected by changing the rule that produced it, with the notice recorded in the
              repository. <a href={RIGHT_OF_REPLY_ISSUE}>Open a right-of-reply issue</a>{' '}
              or see <a href={RIGHT_OF_REPLY_DOC}>docs/RIGHT-OF-REPLY.md</a>. Pre-publication notice is
              deliberately <em>not</em> claimed: the sweep publishes on a timer and for most findings the
              subject is a contract, not a person to notify.
            </div>
          </div>
        )}

        <footer>
          {retained ? (
            <>Reproduce this yourself. These citations were minted {fmtAge(citedAt)} and the block is still served:</>
          ) : (
            <>
              Reproduce this yourself. These citations were minted {fmtAge(citedAt)}, and the public RPC
              serves a block for only 8 to 17 minutes, so these commands may now return a missing-state
              error. That makes a citation <strong>unchecked here, not disproven</strong>. Without{' '}
              <span className="mono">--block</span> a command reads the current value instead, which
              differs if the state has moved:
            </>
          )}
          {f.evidence.map((e, i) => (
            <pre key={i} style={{ marginTop: 10 }}>
              {castFor(e)}
            </pre>
          ))}
          The public RPC serves state for 5,000–10,000 blocks at 0.101s each — measured, not estimated.
          ASSAY reports an unchecked citation and a contradicted one separately, and never publishes a
          finding whose citation contradicts chain state.
        </footer>
      </main>
    </>
  )
}
