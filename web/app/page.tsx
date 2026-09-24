import { loadSweepLive } from '@/lib/findings'
import { landingFacts } from '@/lib/landing'
import { LegacyHash } from './_components/legacy-hash'
import { Stage } from './_landing/stage'
import { Steps } from './_landing/steps'
import { Hero, Rail } from './_landing/sections/hero'
import { OpenWall } from './_landing/sections/open-wall'
import { UseIt } from './_landing/sections/use-it'
import { WhoReads } from './_landing/sections/who-reads'

/**
 * The landing: one Stock Token bar assayed in five steps, then who reads it wrong, how to use it,
 * and the way into the wall.
 *
 * force-static + revalidate: ISR, even though loadSweepLive() fetches with cache: 'no-store',
 * because force-static short-circuits the dynamic bail-out that fetch would otherwise trigger.
 * The HTML can therefore be up to a minute old when served, which is why nothing on it states a
 * relative time until the browser has computed one (see sections/swept.tsx).
 */
export const dynamic = 'force-static'
export const revalidate = 60

/**
 * The sticky stage needs its script to show anything past the hero. If the layout's pre-paint
 * script chose it (html[data-motion="full"]) but the stage module has not reached the browser
 * within 5 seconds (blocked or failed JS), fall back to the static column, where every step is
 * plain text. See the __assayStage mark in _landing/stage.tsx.
 */
const STAGE_FALLBACK = `setTimeout(function(){try{var h=document.documentElement;if(!window.__assayStage&&h.dataset.motion==='full')h.dataset.motion='static'}catch(e){}},5000)`

export default async function Home() {
  const board = await loadSweepLive()
  const facts = landingFacts(board)
  return (
    <main id="main" data-page="landing">
      <script dangerouslySetInnerHTML={{ __html: STAGE_FALLBACK }} />
      <LegacyHash />
      <Stage bar={facts.bar}>
        <Hero facts={facts} />
        <Rail bar={facts.bar} />
        <Steps facts={facts} />
      </Stage>
      <WhoReads agg={board.integrators} namedWithheld={board.withheld?.namedIntegrators} block={facts.blockNumber} />
      <UseIt />
      <OpenWall facts={facts} />
    </main>
  )
}
