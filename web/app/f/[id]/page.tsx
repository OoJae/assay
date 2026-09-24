import type { Metadata } from 'next'
import Link from 'next/link'
import { Fragment } from 'react'
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
import { AssayMark } from '../../_brand/mark'
import { TransitionLink } from '../../_motion/transition-link'

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

/**
 * Raw return bytes, as the EVM returns them: whole 32-byte words, with each word's zero padding
 * dimmed so the significant bytes read first. The spans add no characters, so the text (and what
 * a reader copies) is exactly rawReturn; globals.css (.bytes) breaks it into one word per line.
 */
function Bytes({ hex, state }: { hex: string; state: BytesState }) {
  const cls = `bytes bytes--${state}`
  const m = /^0x((?:[0-9a-fA-F]{64})+)$/.exec(hex)
  if (!m) return <pre className={cls}>{hex}</pre>
  const words = m[1]!.match(/.{64}/g)!
  return (
    <pre className={cls}>
      <span className="bytes__pad">0x</span>
      {words.map((w, i) => {
        const sig = w.replace(/^0+/, '')
        return (
          <Fragment key={i}>
            {sig.length < w.length ? <span className="bytes__pad">{w.slice(0, w.length - sig.length)}</span> : null}
            {sig}
          </Fragment>
        )
      })}
    </pre>
  )
}

/**
 * Colour follows what the verifier established, and the board only records it per finding. Every
 * citation reproduced: the bytes are gold. None reproduced (pruned or contradicted): aqua fortis.
 * Anything in between cannot be attributed to a particular citation, so no row claims either.
 */
type BytesState = 'ok' | 'refused' | 'mixed'

/** "call() == value": the decoded value is split off so it can sit in gold beside its bytes. */
function Claim({ text, struck }: { text: string; struck: boolean }) {
  const at = text.lastIndexOf(' == ')
  if (!struck || at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at + 4)}
      <span className="claim__val">{text.slice(at + 4)}</span>
    </>
  )
}

/** A finding that would name a holder contract: withheld from this site, and said so. */
function Withheld() {
  const cc = PAID_ENDPOINTS.checkContract
  return (
    <>
      <main id="main" className="wrap cert">
        <TransitionLink className="back" href="/wall">
          ← All findings
        </TransitionLink>
        <header className="top">
          <div className="tag">Withheld</div>
          <h1 className="cert__title">Findings that name a holder contract are not published here.</h1>
          <p className="lede">
            This id has the shape of a finding that names a contract holding Stock Tokens without a{' '}
            <span className="mono">uiMultiplier()</span> reference. That verdict establishes the absence of
            a call, not the presence of a mistake, so no such contract is named on this site: they are
            counted, as an aggregate, in the integrator panel on the findings wall. This page is the same for
            every id of this shape and says nothing about whether one exists. The ${cc.priceUsd.toFixed(2)}{' '}
            <span className="mono">{cc.capability}</span> call answers for an address you supply.
          </p>
        </header>
        <div className="cert__foot">
          <a href={cc.paywall}>Audit a contract · ${cc.priceUsd.toFixed(2)}</a> ·{' '}
          <Link href="/wall">← Back to the findings wall</Link>
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
  const checked = f.verification?.checked ?? 0
  const reproduced = f.verification?.reproduced ?? 0
  // The hallmark is struck only when every citation on the page was re-fetched and matched.
  const struck =
    checked > 0 && reproduced === checked && checked >= f.evidence.length && (f.verification?.mismatched ?? 0) === 0
  const bytesState: BytesState = struck ? 'ok' : checked > 0 && reproduced === 0 ? 'refused' : 'mixed'

  return (
    <>
      <main id="main" className="wrap cert">
        <TransitionLink className="back" href="/wall">
          ← All findings
        </TransitionLink>
        <header className="cert__head">
          <div className={struck ? 'cert__mark cert__mark--struck' : 'cert__mark'}>
            <AssayMark size={64} title="" />
          </div>
          <div>
            <div className="tag cert__stamp">
              <span className={`sev ${f.severity}`}>{f.severity}</span> <span>{f.defectClass}</span>
            </div>
            <h1 className="cert__title">{f.title}</h1>
            <div className="meta">
              read from {f.subject} · methodology {f.methodologyVersion} · detected {f.detectedAt}
            </div>
            <div className="meta">
              {d.source === 'committed' ? <span className="badge">LIVE FEED UNREACHABLE</span> : null}{' '}
              {fresh ? null : <span className="badge">STALE SNAPSHOT</span>} from the sweep at block{' '}
              {d.blockNumber}, {fmtAge(d.observedAt)}
              {fresh ? '' : '; this condition may have changed since'}
            </div>
          </div>
        </header>

        {f.affectedParty ? (
          <section className="cert__row" aria-labelledby="exposure-h">
            <h2 className="tag" id="exposure-h">
              Who carries the exposure
            </h2>
            <div>
              <div className="cert__text">{f.affectedParty}</div>
              <div className="note">
                The contract named above is what was READ. Naming it is not an accusation against it:
                a Stock Token that moves uiMultiplier() is doing what ERC-8056 specifies.
              </div>
            </div>
          </section>
        ) : null}

        <div className="cert__row">
          <div aria-hidden="true" />
          <p className="cert__statement">{f.statement}</p>
        </div>

        <section className="cert__row" aria-labelledby="impact-h">
          <h2 className="tag" id="impact-h">
            Impact
          </h2>
          <div>
            {impact.figure ? (
              <div className="cert__figure">
                <span className="num">{impact.figure}</span>
                {impact.measures ? <span className="meta"> · {impact.measures}</span> : null}
              </div>
            ) : null}
            <div className="cert__text cert__text--quiet">{f.impact.note}</div>
          </div>
        </section>

        <section className="cert__row" aria-labelledby="evidence-h">
          <h2 className="tag" id="evidence-h">
            Evidence — <span className={struck ? 'streak' : undefined}>{reproduced}/{checked}</span> citations
            re-fetched and byte-compared
          </h2>
          <div>
            <div className="meta cert__evmeta">
              mismatched {f.verification?.mismatched ?? 0} · pruned {f.verification?.pruned ?? 0} ·
              verified {f.verification?.verifiedAt}
            </div>
            {f.evidence.map((e, i) => (
              <div className="ev" key={i}>
                <div className="claim">
                  <Claim text={e.claim} struck={struck} />
                </div>
                <div className="meta">
                  chain {e.chainId} · block {e.blockNumber} · {e.call}
                  <br />
                  <a href={e.explorerUrl} target="_blank" rel="noreferrer">
                    {e.contract}
                  </a>
                </div>
                <Bytes hex={e.rawReturn} state={bytesState} />
              </div>
            ))}
          </div>
        </section>

        {f.offChainSources?.length ? (
          <section className="cert__row" aria-labelledby="offchain-h">
            <h2 className="tag" id="offchain-h">
              Off-chain inputs — NOT covered by the byte-verified guarantee
            </h2>
            <div>
              <div className="note">
                The citations above are re-fetched from chain state and byte-compared. The values below
                cannot be, because they do not live on chain. They are listed so you can tell the
                difference.
              </div>
              {f.offChainSources.map((o, i) => (
                <div className="ev ev--offchain" key={i}>
                  <div className="claim">{o.describes}</div>
                  <div className="meta">
                    fetched {o.fetchedAt}
                    <br />
                    <a href={o.url} target="_blank" rel="noreferrer">{o.url}</a>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {replies.length ? (
          <section className="cert__row" aria-labelledby="reply-h">
            <h2 className="tag" id="reply-h">
              Reply from a named party — published verbatim
            </h2>
            <div>
              {replies.map((r, i) => (
                <div className="ev ev--reply" key={i}>
                  <div className="claim">{r.from}</div>
                  <div className="reply__text">{r.text}</div>
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
                    <div className="reply__response">
                      <div className="tag">ASSAY&apos;s response — not part of the reply above</div>
                      <div className="cert__text">{r.assayResponse}</div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : (
          <section className="cert__row" aria-labelledby="reply-h">
            <h2 className="tag" id="reply-h">
              Right of reply
            </h2>
            <div className="cert__text cert__text--quiet">
              No reply has been received for this finding. Anyone named here can have a response
              published <strong>verbatim and unedited</strong> alongside it. A finding shown to be wrong
              is corrected by changing the rule that produced it, with the notice recorded in the
              repository. <a href={RIGHT_OF_REPLY_ISSUE}>Open a right-of-reply issue</a>{' '}
              or see <a href={RIGHT_OF_REPLY_DOC}>docs/RIGHT-OF-REPLY.md</a>. Pre-publication notice is
              deliberately <em>not</em> claimed: the sweep publishes on a timer and for most findings the
              subject is a contract, not a person to notify.
            </div>
          </section>
        )}

        <footer className="repro">
          <p className="repro__lead">
            <span className="repro__title">Reproduce this yourself.</span>{' '}
            {retained ? (
              <>These citations were minted {fmtAge(citedAt)} and the block is still served:</>
            ) : (
              <>
                These citations were minted {fmtAge(citedAt)}, and the public RPC
                serves a block for only 8 to 17 minutes, so these commands may now return a missing-state
                error. That makes a citation <strong>unchecked here, not disproven</strong>. Without{' '}
                <span className="mono">--block</span> a command reads the current value instead, which
                differs if the state has moved:
              </>
            )}
          </p>
          <div className="repro__cmds">
            {f.evidence.map((e, i) => (
              <pre key={i}>{castFor(e)}</pre>
            ))}
          </div>
          <p className="note">
            The public RPC serves state for 5,000–10,000 blocks at 0.101s each — measured, not estimated.
            ASSAY reports an unchecked citation and a contradicted one separately, and never publishes a
            finding whose citation contradicts chain state.
          </p>
        </footer>
      </main>
    </>
  )
}
