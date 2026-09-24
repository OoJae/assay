'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { LandingBar } from '@/lib/landing'
import { STEP_EDGES, createProgressStore } from '../_landing/progress'
import type { SceneFailure } from '../_landing/scene/engine'
import { POSTER_PROGRESS } from '../_landing/scene/pose'

// Loaded the way the landing loads it, so three.js only ever arrives in a lazy chunk.
const AssayCanvas = dynamic(() => import('../_landing/scene/canvas'), { ssr: false })

const STEPS = ['01 weigh', '02 read the multiplier', '03 strike', '04 divide', '05 re-fetch']

function stepAt(p: number) {
  for (let i = STEPS.length - 1; i >= 0; i--) if (p >= STEP_EDGES[i]!) return STEPS[i]!
  return STEPS[0]!
}

/**
 * The scene bench (see page.tsx). The scroll track writes store.target straight from the scroll
 * event, as the landing's ScrollTrigger will, and the readout is written to the DOM directly so the
 * bench adds no React work to the frames it is used to measure. Keys 1–5 jump to each poster pose.
 */
export function DevScene({ bar, poster, still }: { bar: LandingBar | null; poster: number | null; still: number | null }) {
  const frozen = poster !== null || still !== null
  const store = useMemo(() => {
    const s = createProgressStore('webgl')
    s.target = s.current = still ?? 0
    return s
  }, [still])
  const track = useRef<HTMLDivElement>(null)
  const hud = useRef<HTMLParagraphElement>(null)
  const state = useRef({ status: 'loading', strikes: 0 })

  const paint = useCallback(() => {
    const el = hud.current
    if (!el) return
    const { status, strikes } = state.current
    el.textContent = `p ${store.target.toFixed(3)} → ${store.current.toFixed(3)} · ${stepAt(store.current)} · strikes ${strikes} · ${status}`
  }, [store])

  const onReady = useCallback(() => {
    document.documentElement.dataset.sceneReady = '1'
    state.current.status = 'ready'
    paint()
  }, [paint])
  const onFail = useCallback(
    (reason: SceneFailure) => {
      document.documentElement.dataset.sceneReady = `fail:${reason}`
      state.current.status = `failed: ${reason}`
      paint()
    },
    [paint],
  )

  useEffect(() => {
    store.onStrike = () => {
      state.current.strikes++
      paint()
    }
    return () => {
      store.onStrike = undefined
      delete document.documentElement.dataset.sceneReady
    }
  }, [store, paint])

  useEffect(() => {
    if (frozen) {
      const html = document.documentElement
      html.style.overflow = 'hidden'
      return () => {
        html.style.overflow = ''
      }
    }
    let raf = 0
    const read = () => {
      const el = track.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const span = r.height - window.innerHeight
      store.target = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 0
      store.onChange?.()
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          paint()
        })
    }
    const key = (e: KeyboardEvent) => {
      const n = Number(e.key)
      const el = track.current
      if (!el || !(n >= 1 && n <= 5)) return
      const top = el.getBoundingClientRect().top + window.scrollY
      window.scrollTo({ top: top + POSTER_PROGRESS[n - 1]! * (el.offsetHeight - window.innerHeight) })
    }
    read()
    window.addEventListener('scroll', read, { passive: true })
    window.addEventListener('resize', read)
    window.addEventListener('keydown', key)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
      window.removeEventListener('keydown', key)
    }
  }, [frozen, store, paint])

  if (frozen) {
    return (
      <main id="main" style={{ position: 'fixed', inset: 0, zIndex: 2147483000, background: '#0D0D0C' }}>
        {/* The capture must be the scene alone: hide Next's dev-mode badge. */}
        <style>{'nextjs-portal{display:none!important}'}</style>
        <AssayCanvas bar={bar} store={store} poster={poster ?? undefined} onReady={onReady} onFail={onFail} />
      </main>
    )
  }

  return (
    <main id="main">
      <div ref={track} style={{ position: 'relative', height: '600vh' }}>
        <div style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'hidden', background: '#0D0D0C' }}>
          <AssayCanvas bar={bar} store={store} onReady={onReady} onFail={onFail} />
          <p
            ref={hud}
            className="data"
            style={{ position: 'absolute', left: 16, bottom: 12, margin: 0, color: 'var(--ash)', fontSize: 12 }}
          />
        </div>
      </div>
    </main>
  )
}
