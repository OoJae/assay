import { SERV_EXAMPLE, SERV_HARD, SERV_HELDOUT, SERV_INJECTION, SERV_SOURCES } from '@/lib/serv-example'
import { REPO } from '@/lib/site'
import { Reveal } from '../_motion/reveal'

/**
 * Where the sponsor's model actually does work.
 *
 * The wall used to show no SERV at all, and the only SERV message anywhere public was a null
 * result, so an entry that does use SERV Reasoning read as a Robinhood Chain tool that never
 * touches it. This says where it runs, shows one recorded output, and keeps the measurement's
 * limits next to it.
 */
export function ServReasoning() {
  const e = SERV_EXAMPLE
  return (
    <section className="ledger" aria-labelledby="serv">
      <Reveal as="h2" className="h2" id="serv">
        Where SERV Reasoning runs
      </Reveal>
      <p className="sub">
        Nothing on this page, and neither paid call, uses a model: every number is read from chain state
        and re-fetched before it is published. SERV Reasoning does the one job that needs judgement. When
        a subject asks for an ERC-8004 verdict about itself, it decides whether a byte-verified finding
        is <em>material</em> against the subject&apos;s own declared mandate.
      </p>
      <ul className="sub list">
        <li>
          <strong>Adjudicator</strong> (<span className="mono">{e.model}</span>): four ordered gates
          lead to BENIGN, CONTROL_WEAKNESS, MATERIAL_MISSTATEMENT or WITHHELD. It never computes a fact.
        </li>
        <li>
          <strong>
            <span className="mono">serv_prompt_guard</span>
          </strong>{' '}
          is sent on every call, because the mandate is written entirely by the party being graded. We
          have not been able to observe it trip.
        </li>
        <li>
          <strong>
            <span className="mono">serv_shadow_agent</span>
          </strong>{' '}
          (5 iterations) is asked to hold the verdict to the evidence: gates in order, every cited claim
          verbatim, and a mandate that never states the operation gets CONTROL_WEAKNESS, not an
          accusation. The response does not say whether it ran, so its effect is unmeasured.
        </li>
      </ul>

      <div className="card record">
        <div className="tag">One recorded adjudication · {e.generatedAt.slice(0, 10)}</div>
        <div className="meta">
          finding {e.findingId} · {e.evidenceClaim} · {e.citations}
        </div>
        <p className="sub">
          Declared mandate (a measurement fixture, not a real subject): &ldquo;…{e.mandateExcerpt}&rdquo;
        </p>
        <p className="record__verdict">
          Verdict <span className="mono">{e.verdict}</span> ({e.severity})
        </p>
        <blockquote className="quote">{e.rationale}</blockquote>
        <div className="note">
          The unsafe answer would have been <span className="mono">{e.unsafeVerdict}</span>: accusing the
          subject of a defect the evidence never shows, since &ldquo;displayed in shares&rdquo; is not
          &ldquo;computed from balanceOf()&rdquo;. input hash {e.inputHash.slice(0, 18)}… ·{' '}
          <a href={`${REPO}/blob/main/${SERV_SOURCES.ab}`}>raw artifact</a>
        </div>
      </div>

      <p className="sub">
        Against {SERV_INJECTION.payloads} hostile mandates, with the guard on and off,{' '}
        {SERV_INJECTION.compromised} of {SERV_INJECTION.calls} calls were talked into BENIGN and{' '}
        {SERV_INJECTION.withheld} were WITHHELD. <span className="mono">serv_prompt_guard</span> reported
        no trigger in any of the {SERV_INJECTION.calls}; the refusals were the adjudicator&apos;s own (
        <a href={`${REPO}/blob/main/${SERV_SOURCES.injection}`}>artifact</a>). The current rubric scored{' '}
        {SERV_HARD.correct}/{SERV_HARD.attempted} per arm on the hard set, but its gate 4 was tightened
        against that same set, so that is a tuning-set result. On {SERV_HELDOUT.cases} held-out mandates,
        written blind and pre-registered, BRAID off got {SERV_HELDOUT.braidOff.correct} right (95%
        interval {SERV_HELDOUT.braidOff.lowerPct}–{SERV_HELDOUT.braidOff.upperPct}%); BRAID on refused{' '}
        {SERV_HELDOUT.braidOn.refused} of its {SERV_HELDOUT.braidOn.calls} calls (
        <a href={`${REPO}/blob/main/${SERV_SOURCES.heldout}`}>artifact</a>).{' '}
        <a href={`${REPO}#what-we-measured-about-serv-and-what-we-found`}>What we measured, in full</a>.
      </p>
    </section>
  )
}
