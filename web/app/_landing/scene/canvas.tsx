'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LandingBar } from '@/lib/landing'
import type { ProgressStore } from '../progress'
import { startEngine, type SceneFailure } from './engine'

export type { SceneFailure }

export interface AssayCanvasProps {
  /** The bar to strike, from landingFacts(). Its stamps and hallmark are drawn from these values. */
  bar: LandingBar | null
  /** Written by the stage (target); the canvas damps toward it and writes current, and calls onStrike. */
  store: ProgressStore
  /** The first frame is compiled, rendered and on screen. The canvas has begun its own fade-in. */
  onReady?: () => void
  /** WebGL is unavailable, the context was lost, or the device is too slow: show the posters instead. */
  onFail?: (reason: SceneFailure) => void
  /** 1..5: render that step's poster pose once, fully opaque, for capture. Never animates. */
  poster?: number
  className?: string
}

/**
 * The assay scene: the lazily loaded 3D chunk's only export. It fills its positioned parent and
 * is decorative (aria-hidden): every number it shows is also in the page's text.
 *
 * It stays transparent until the first frame is ready and then fades itself in, so a parent can
 * lay it over a poster frame and simply wait for onReady before retiring the poster.
 */
export default function AssayCanvas({ bar, store, onReady, onFail, poster, className }: AssayCanvasProps) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const callbacks = useRef({ onReady, onFail })
  useEffect(() => {
    callbacks.current = { onReady, onFail }
  }, [onReady, onFail])

  // Rebuild only when what the metal shows changes, not when a parent passes an equal new object.
  const barKey = bar
    ? [bar.findingId, bar.symbol, bar.block, bar.supply.raw, bar.multiplier.raw, bar.segments ?? 0].join('|')
    : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableBar = useMemo(() => bar, [barKey])
  const still = poster && poster >= 1 && poster <= 5 ? Math.round(poster) : null

  useEffect(() => {
    const el = host.current
    if (!el) return
    setReady(false)
    return startEngine({
      host: el,
      bar: stableBar,
      store,
      poster: still,
      onReady: () => {
        setReady(true)
        callbacks.current.onReady?.()
      },
      onFail: (reason) => callbacks.current.onFail?.(reason),
    })
  }, [stableBar, store, still])

  return (
    <div
      ref={host}
      aria-hidden="true"
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        opacity: ready ? 1 : 0,
        transition: still ? undefined : 'opacity 700ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    />
  )
}
