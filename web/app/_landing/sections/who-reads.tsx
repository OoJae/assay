import type { Integrators } from '@/lib/findings'
import { fmtUsd, integratorView, listJoin } from '@/lib/present'
import { PAID_ENDPOINTS } from '@/lib/endpoints'
import { Reveal } from '../../_motion/reveal'
import { TransitionLink } from '../../_motion/transition-link'
import s from './sections.module.css'

/**
 * Who reads it wrong: the contracts on the other side of the trade, as counts, never as names.
 *
 * The same aggregate and the same reading as the wall's panel (integratorView in lib/present):
 * pools, pool managers, custody and distributors hold reserves and never report a share count, so
 * lacking the multiplier is not an exposure for them; the rest of the contracts could be exposed.
 * What the counts establish is a missing call, not a mistake, and the copy says so. Names are the
 * $0.25 audit's, and the board this page reads has already had them taken out.
 */
export function WhoReads({
  agg,
  namedWithheld,
  block,
}: {
  agg: Integrators | undefined
  namedWithheld: number | undefined
  block: string
}) {
  if (!agg || agg.contracts <= 0) return null
  const v = integratorView(agg)
  const price = `$${PAID_ENDPOINTS.checkContract.priceUsd.toFixed(2)}`
  const floor = (unpriced: number) => (unpriced > 0 ? 'at least ' : '')
  const withheldNote =
    typeof namedWithheld === 'number' && namedWithheld > 0
      ? ` ${namedWithheld} ${namedWithheld === 1 ? 'finding that would name one is' : 'findings that would name one are'} withheld from every public page.`
      : ''

  return (
    <section className={s.section} aria-labelledby="who-reads">
      <div className={s.wrap}>
        <div className={s.rule}>
          <span className="label">Who reads it wrong</span>
          <span className="label">Holder contracts · block {block}</span>
        </div>

        {v.shape === 'distinct' ? (
          <>
            <Reveal as="h2" id="who-reads" className={`display t-section ${s.head}`}>
              {v.aware === 0 ? 'none of them read the multiplier.' : `${v.resolved - v.aware} of ${v.resolved} never read the multiplier.`}
            </Reveal>
            <p className={s.lede}>
              Of the {v.scanned} addresses seen moving {covered(v)}, {v.contracts} are contracts.{' '}
              {v.aware === 0
                ? `Not one of the ${v.resolved} we could read references `
                : `${v.aware} of the ${v.resolved} we could read ${v.aware === 1 ? 'references' : 'reference'} `}
              <span className={s.call}>uiMultiplier()</span>.
              {v.proxyUnresolved > 0
                ? ` ${v.proxyUnresolved} ${v.proxyUnresolved === 1 ? 'is a proxy' : 'are proxies'} we could not resolve, and no claim is made about ${v.proxyUnresolved === 1 ? 'it' : 'them'}.`
                : ''}
            </p>

            <Tally v={v} />

            <div className={s.split}>
              <div className={s.side}>
                <p className={s.count}>{v.notAware}</p>
                <h3 className={s.sideHead}>could be exposed</h3>
                <p className={s.body}>
                  {v.notAware === 1 ? 'It holds' : 'They hold'} {floor(v.unpricedNotAware)}
                  {fmtUsd(v.usdNotAware)} of these tokens with no <span className={s.call}>uiMultiplier()</span> in{' '}
                  {v.notAware === 1 ? 'its' : 'their'} logic and no pool or custody fingerprint. Read as share
                  counts, {v.notAware === 1 ? 'its balances miss' : 'their balances miss'}{' '}
                  {v.sharesUnaccounted.toFixed(2)} share-equivalents.
                </p>
              </div>
              <div className={s.side}>
                <p className={s.count}>{v.notApplicable}</p>
                <h3 className={s.sideHead}>never need it</h3>
                <p className={s.body}>
                  {v.roles.length
                    ? listJoin(v.roles.map((r) => `${r.contracts} ${r.label}`))
                    : 'Pools, pool managers, custody wallets and distributors'}{' '}
                  hold {floor(v.unpricedNotApplicable)}
                  {fmtUsd(v.usdNotApplicable)}. They keep reserves or custody and never report a share count, so
                  going without the multiplier is not an exposure for them.
                </p>
              </div>
            </div>

            <p className={s.fine}>
              {v.tooSmall} more {v.tooSmall === 1 ? 'is' : 'are'} too small to hold valuation logic, and {v.noHolding}{' '}
              held none of these tokens at the block
              {v.unreadContracts > 0 ? `; ${v.unreadContracts} could not be read` : ''}. This shows a missing call, not
              a mistake, and no contract is named here.{withheldNote} The named audit of any address, with its
              bytecode evidence, is the {price} call below.
            </p>
          </>
        ) : (
          <>
            <Reveal as="h2" id="who-reads" className={`display t-section ${s.head}`}>
              {v.aware === 0 ? 'none of them read the multiplier.' : 'most of them never read the multiplier.'}
            </Reveal>
            <p className={s.lede}>
              {v.notAwareHoldings} of {v.holdings} contract holdings of Stock Tokens whose multiplier is not 1 carry
              at least {fmtUsd(v.usdNotAware)} with no <span className={s.call}>uiMultiplier()</span> in their
              bytecode. This board predates distinct counting, so pools and custody, which never need the multiplier,
              are still inside that figure. No contract is named here.
            </p>
          </>
        )}

        <p className={s.more}>
          <TransitionLink href="/wall">The full breakdown is on the wall</TransitionLink>
        </p>
      </div>
    </section>
  )
}

type Distinct = Extract<ReturnType<typeof integratorView>, { shape: 'distinct' }>

/**
 * Which tokens the holder scan covered. It reads the holders of the tokens past the sweep's
 * divergence cutoff, not of every token whose multiplier differs from 1, so the sentence says so.
 */
function covered(v: Distinct): string {
  const n = v.assetsScanned.length
  if (n === 0) return 'Stock Tokens whose multiplier is not 1'
  const pct = v.minDivergencePct ?? 0.2
  return `the ${n} Stock ${n === 1 ? 'Token' : 'Tokens'} whose multiplier is more than ${pct}% from 1`
}

/**
 * One tick per contract, in the order the copy takes them: could be exposed, never need it, then
 * the rest (too small, held none, unread, unresolved, and any that do read the multiplier). A
 * picture of the counts printed beside it, so it is hidden from assistive tech.
 */
function Tally({ v }: { v: Distinct }) {
  const groups: Array<[number, string]> = [
    [v.notAware, s.tExposed!],
    [v.notApplicable, s.tNever!],
    [v.tooSmall + v.noHolding + v.unreadContracts + v.proxyUnresolved + v.aware, s.tRest!],
  ]
  const total = groups.reduce((n, [c]) => n + c, 0)
  if (total <= 0 || total > 400) return null
  const ticks: string[] = []
  for (const [count, cls] of groups) for (let i = 0; i < count; i++) ticks.push(cls)
  return (
    <div className={s.tally} aria-hidden="true">
      {ticks.map((cls, i) => (
        <span key={i} className={cls} />
      ))}
    </div>
  )
}
