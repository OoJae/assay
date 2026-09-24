import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { loadSweep } from '@/lib/findings'
import { landingFacts } from '@/lib/landing'
import { DevScene } from './dev-scene'

/**
 * DEVELOPMENT ONLY: a bench for the assay scene, away from the landing page.
 *
 *   /dev-scene            a tall scroll track driving a sticky canvas, as the landing will
 *   /dev-scene?p=0.37     one frozen pose at any progress, full screen
 *   /dev-scene?poster=3   step 3's poster pose, full screen, no UI: what the poster capture shoots
 *   &seg=0|2..8           pretend the multiplier gave that many pieces (0 = a whole bar), to check
 *                         the layouts the committed board never produces
 *
 * The facts are the committed board's (loadSweep, no network), so posters are always struck from
 * the same bytes. A production build answers 404.
 */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Scene bench', robots: { index: false, follow: false } }

type Search = Promise<Record<string, string | string[] | undefined>>

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

export default async function DevScenePage({ searchParams }: { searchParams: Search }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const sp = await searchParams
  const poster = Number(one(sp.poster))
  const p = Number(one(sp.p))
  const facts = landingFacts(loadSweep())
  const seg = one(sp.seg)
  const bar =
    facts.bar && seg !== undefined
      ? { ...facts.bar, segments: Number(seg) >= 2 && Number(seg) <= 8 ? Math.round(Number(seg)) : null }
      : facts.bar
  return (
    <DevScene
      bar={bar}
      poster={Number.isInteger(poster) && poster >= 1 && poster <= 5 ? poster : null}
      still={one(sp.p) !== undefined && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null}
    />
  )
}
