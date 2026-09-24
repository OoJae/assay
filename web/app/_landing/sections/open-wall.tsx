import type { LandingFacts } from '@/lib/landing'
import { Reveal } from '../../_motion/reveal'
import { TransitionLink } from '../../_motion/transition-link'
import s from './sections.module.css'

/** The way in: the wall, where every finding sits with the bytes behind it. */
export function OpenWall({ facts }: { facts: LandingFacts }) {
  const all = facts.citations.total > 0 && facts.citations.ok === facts.citations.total
  return (
    <section className={`${s.section} ${s.end}`} aria-labelledby="open-wall">
      <div className={s.wrap}>
        <div className={s.rule}>
          <span className="label">The wall</span>
          <span className="label">
            {facts.source === 'live' ? 'Live board' : 'Committed snapshot'} · block {facts.blockNumber}
          </span>
        </div>
        <Reveal as="h2" id="open-wall" className={`display t-section ${s.head} ${s.endHead}`}>
          every finding, with the bytes behind it.
        </Reveal>
        <p className={s.lede}>
          {facts.findings} {facts.findings === 1 ? 'finding' : 'findings'} on the board, {facts.critical} critical.{' '}
          <span className={all ? 'streak' : undefined}>
            {facts.citations.ok} of {facts.citations.total}
          </span>{' '}
          citations re-fetched and byte-compared. Every finding opens to its raw returns, the blocks they were read at,
          and the command that repeats each read.
        </p>
        <div className={s.ctas}>
          <TransitionLink className="btn primary" href="/wall">
            Open the live wall
          </TransitionLink>
          <TransitionLink className="btn" href="/wall#check">
            Check a wallet · free
          </TransitionLink>
        </div>
      </div>
    </section>
  )
}
