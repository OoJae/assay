import type { LandingBar, LandingFacts } from '@/lib/landing'
import { tail } from '../steps'
import s from '../stage.module.css'
import { Swept } from './swept'

/**
 * The first frame of the stage: the thesis, with the one number that proves it set inline.
 *
 * Bodoni italic for the sentence and Martian Mono for the figure, on one line: ceremony and bytes
 * together. The figure is the decoded uiMultiplier() of the bar below, streak because it was
 * byte-verified and its bytes sit beside it in the rail. The share count in the lede is derived,
 * so it stays cupel while the two values it comes from are streak.
 */
export function Hero({ facts }: { facts: LandingFacts }) {
  const b = facts.bar
  const all = facts.citations.total > 0 && facts.citations.ok === facts.citations.total
  return (
    <div className={s.hero} data-hero="">
      <div className={s.heroMain}>
        <p className={`label ${s.eyebrow}`}>Independent audit · Stock Tokens · ERC-8056</p>
        <h1 className={`display ${s.thesis}`}>
          <span className={s.line}>a token</span> <span className={s.line}>is not</span>{' '}
          <span className={s.line}>
            a share
            {b ? (
              <>
                {' '}
                <span className={s.dash} aria-hidden="true">
                  —
                </span>{' '}
                <span className={`streak ${s.fig}`}>
                  <span aria-hidden="true">×</span>
                  <span className={s.srOnly}>: the multiplier is </span>
                  {b.multiplier.value}
                </span>
              </>
            ) : (
              '.'
            )}
          </span>
        </h1>
        {b ? (
          <p className={s.lede}>
            {b.symbol}&apos;s <span className={s.call}>totalSupply()</span> reads{' '}
            <span className={`streak ${s.num}`}>{b.supply.tokens}</span> tokens. Its{' '}
            <span className={s.call}>uiMultiplier()</span> is{' '}
            <span className={`streak ${s.num}`}>{b.multiplier.value}</span>, so they count as{' '}
            <span className={s.num}>{b.shares}</span> shares. ASSAY reads both from Robinhood Chain and publishes
            only what <span className={s.nowrap}>re-fetches</span> byte for byte.
          </p>
        ) : (
          <p className={s.lede}>
            Under ERC-8056 a corporate action moves <span className={s.call}>uiMultiplier()</span>, not
            balances, so <span className={s.call}>balanceOf()</span> is not a share count. ASSAY reads Stock
            Tokens on Robinhood Chain and publishes only what <span className={s.nowrap}>re-fetches</span> byte
            for byte.
          </p>
        )}
      </div>
      <div className={s.heroFoot}>
        <p className={`label ${s.cue}`}>
          <span aria-hidden="true">↓ </span>Scroll to assay it
        </p>
        <p className={`label ${s.prov}`}>
          {facts.source === 'live' ? 'Live board' : 'Committed snapshot'} · block {facts.blockNumber} ·{' '}
          <span className={all ? 'streak' : undefined}>
            {facts.citations.ok}/{facts.citations.total}
            {all ? ' ✓' : ''}
          </span>{' '}
          re-fetched · swept <Swept observedAt={facts.observedAt} staleAfter={facts.staleAfter} />
        </p>
      </div>
    </div>
  )
}

/**
 * The assay ledger: the bar's two cited reads and the block they share, on the right edge of the
 * stage. Each row names the steps that read it in `data-on`, and the stylesheet lights those rows
 * as the stage's data-step moves; with no JS every row is lit. In a portrait frame there is no
 * room beside the bar, and every caption already prints the same reads, so it is left out there;
 * the static column keeps it as a two-by-two block under the hero.
 */
export function Rail({ bar }: { bar: LandingBar | null }) {
  if (!bar) return null
  return (
    <aside className={s.rail} data-rail="" aria-label={`Assay ledger for ${bar.symbol}`}>
      <p className={`label ${s.railHead}`}>Ledger · {bar.symbol}</p>
      <dl className={s.railList}>
        <div className={s.row} data-on="0 1 2 3 4 5" data-row="block">
          <dt>Block</dt>
          <dd>{bar.block}</dd>
        </div>
        <div className={s.row} data-on="1 4" data-row="supply">
          <dt>totalSupply()</dt>
          <dd className="streak">{bar.supply.tokens}</dd>
        </div>
        <div className={s.row} data-on="0 2 3 4" data-row="mult">
          <dt>uiMultiplier()</dt>
          <dd className="streak">{bar.multiplier.value}</dd>
        </div>
        <div className={s.row} data-on="0 3 5" data-row="return">
          <dt>Return</dt>
          <dd className="streak" title={bar.multiplier.raw}>
            {tail(bar.multiplier.raw)}{' '}
            <span className={s.tick} aria-hidden="true">
              ✓
            </span>
            <span className={s.srOnly}>
              , re-fetched and matched ({bar.verified.reproduced} of {bar.verified.checked} citations)
            </span>
          </dd>
        </div>
      </dl>
    </aside>
  )
}
