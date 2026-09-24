'use client'

import dynamic from 'next/dynamic'
import { Component, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { LandingBar } from '@/lib/landing'
import { P_STRIKE, STEP_EDGES, createProgressStore, type ProgressStore, type StageMode } from './progress'
import s from './stage.module.css'

/**
 * The assay stage: a sticky frame in a tall track, where the hero gives way to five steps while
 * the scene behind them (posters, or the 3D canvas once it has loaded) follows the scroll.
 *
 * The layout is CSS, chosen before first paint from html[data-motion], so nothing here moves the
 * page once it hydrates: "full" gets the sticky stage, anything else (reduced motion, no JS, or a
 * landscape screen too short for the frame) gets the same markup as a plain column of steps. This
 * component only decides what fills the frame:
 *
 *   static   reduced motion: nothing runs, and any inline style this wrote is removed
 *   posters  the textless poster frames crossfade by progress
 *   webgl    the same, with the canvas faded in over them once it has compiled
 *
 * The steps, the hero and the rail are server-rendered children and work with no JS at all; this
 * finds them by data attribute and writes only opacity, transform and visibility to them.
 */

/**
 * Marks that this module reached the browser. The page's inline fallback (STAGE_FALLBACK in
 * app/page.tsx) looks for it: a sticky layout whose script never arrives would leave every caption
 * at opacity 0, so without this mark the page drops to the static column after 5 seconds. Set at
 * evaluation rather than after hydration, so a slow device that is merely still hydrating keeps
 * the sticky stage.
 */
if (typeof window !== 'undefined') (window as Window & { __assayStage?: true }).__assayStage = true

/** Screens of scroll the hero holds before step 01 starts, and screens per step. */
const HOLD = 0.6
const LEN = 0.9
const STEPS = STEP_EDGES.length - 1
/** Progress spent fading one caption out, and again fading the next one in. */
const CAP_FADE = 0.035
/** Half-width of a poster crossfade, in progress. */
const POSTER_FADE = 0.03
/**
 * When the ledger rail steps aside for the strike, in progress. In every landscape framing the
 * punch comes down through the top right, where the rail sits: it leaves its parked height at .40
 * and is back up by .64 (PUNCH in scene/pose.ts). The rail goes as caption 02 hands over to 03 and
 * returns with 04; the strike is the one beat nothing shares the frame with, and caption 03 prints
 * the same bytes and block the rail would.
 */
const RAIL_ASIDE = [0.38, 0.63] as const
const RAIL_FADE = 0.03
/** One strike per pass: the scene and the poster fallback may both report the same crossing. */
const STRIKE_DEBOUNCE_MS = 800
/** Set when the canvas failed or ran too slowly, so the rest of this visit stays on posters. */
const POSTERS_FLAG = 'assay:landing-3d'
/**
 * Where the stylesheet builds the sticky frame (the same query wraps those rules in
 * stage.module.css). A landscape screen under 501px tall keeps the static column, and the scroll
 * engine must not fade captions that are laid out as plain text there.
 */
const FRAME_QUERY = '(orientation: portrait), (min-height: 501px)'

/**
 * The 3D scene, in its own async chunk (three.js never reaches first load), requested only when
 * the stage decides to show it. Rendering <AssayCanvas> is what fetches the chunk.
 */
const AssayCanvas = dynamic(() => import('./scene/canvas'), { ssr: false })

/** A render error in the scene becomes posters, never a blank landing. */
class CanvasBoundary extends Component<{ onError: (e: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = (x: number) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

type StyleProp = 'opacity' | 'transform' | 'visibility' | 'pointerEvents'

/**
 * Writes an inline style only when it changed. A scroll frame touches a dozen elements; most of
 * them hold still, and an unchanged write still costs a style invalidation.
 */
function writer() {
  const last = new Map<HTMLElement, Partial<Record<StyleProp, string>>>()
  return {
    put(el: HTMLElement, prop: StyleProp, value: string) {
      let m = last.get(el)
      if (!m) last.set(el, (m = {}))
      if (m[prop] === value) return
      m[prop] = value
      el.style[prop] = value
    },
    /** Hands every element back to the stylesheet. */
    reset() {
      for (const [el, m] of last) for (const prop of Object.keys(m) as StyleProp[]) el.style[prop] = ''
      last.clear()
    },
  }
}

function killSwitchOn(): boolean {
  const v = (process.env.NEXT_PUBLIC_LANDING_3D ?? '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false'
}

/**
 * Whether this visit may try WebGL at all, from what is cheap to know at mount. The WebGL2 probe
 * itself waits for the moment the canvas is wanted, so a visitor who never scrolls pays nothing.
 */
function allows3d(q: URLSearchParams): 'no' | 'yes' | 'forced' {
  if (killSwitchOn()) return 'no'
  const flag = q.get('3d')
  if (flag === '0') return 'no'
  if (flag === '1') return 'forced'
  if (document.documentElement.dataset.data === 'save') return 'no'
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (typeof memory === 'number' && memory < 4) return 'no'
  try {
    if (sessionStorage.getItem(POSTERS_FLAG) === 'posters') return 'no'
  } catch {
    /* storage blocked: nothing remembered */
  }
  return 'yes'
}

/** WebGL2 without a major performance caveat (i.e. not a software rasteriser). */
function hasWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true })
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

function posterStep(q: URLSearchParams): number | null {
  const n = Number(q.get('poster'))
  return Number.isInteger(n) && n >= 1 && n <= STEPS ? n : null
}

export function Stage({ bar, children }: { bar: LandingBar | null; children: ReactNode }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const storeRef = useRef<ProgressStore | null>(null)
  storeRef.current ??= createProgressStore('static')
  const store = storeRef.current
  /** True while the canvas is on screen: it then owns `current` and reports the strike itself. */
  const canvasLive = useRef(false)
  /** Set by the scroll engine while it runs: hands the frame to the canvas, or back to the posters. */
  const handOver = useRef<((live: boolean) => void) | null>(null)

  const [sticky, setSticky] = useState(false)
  const [mode, setMode] = useState<StageMode>('static')
  const [canvas, setCanvas] = useState<'off' | 'load' | 'ready'>('off')
  const [capture, setCapture] = useState<number | null>(null)

  // The layout follows html[data-motion], which MotionProvider keeps live if the preference
  // changes, and the frame query, which a phone turning on its side changes.
  useEffect(() => {
    const html = document.documentElement
    const frame = window.matchMedia(FRAME_QUERY)
    const read = () => setSticky(html.dataset.motion === 'full' && frame.matches)
    read()
    const mo = new MutationObserver(read)
    mo.observe(html, { attributes: true, attributeFilter: ['data-motion'] })
    frame.addEventListener('change', read)
    setCapture(posterStep(new URLSearchParams(window.location.search)))
    return () => {
      mo.disconnect()
      frame.removeEventListener('change', read)
    }
  }, [])

  // A poster that fails to load (missing, blocked, offline) is hidden, so the line plate under it
  // shows instead of the browser's broken-image frame. Listening from mount catches the lazy ones.
  useEffect(() => {
    const imgs = [...(stageRef.current?.querySelectorAll<HTMLImageElement>('[data-poster] img') ?? [])]
    const hide = (img: HTMLImageElement) => {
      img.style.visibility = 'hidden'
    }
    const onError = (e: Event) => hide(e.currentTarget as HTMLImageElement)
    // A deferred lazy image can report `complete` before it has loaded at all; a later load wins.
    const onLoad = (e: Event) => {
      ;(e.currentTarget as HTMLImageElement).style.visibility = ''
    }
    for (const img of imgs) {
      if (img.complete && img.naturalWidth === 0) hide(img)
      img.addEventListener('error', onError)
      img.addEventListener('load', onLoad)
    }
    return () => {
      for (const img of imgs) {
        img.removeEventListener('error', onError)
        img.removeEventListener('load', onLoad)
      }
    }
  }, [])

  // Posters or WebGL, decided once the stage is sticky. ?3d= is read here rather than through
  // useSearchParams, which would opt this static page out of prerendering.
  useEffect(() => {
    if (!sticky && capture === null) {
      setMode('static')
      setCanvas('off')
      return
    }
    const q = new URLSearchParams(window.location.search)
    const allowed = bar ? allows3d(q) : 'no'
    if (capture !== null && bar) {
      setMode('webgl')
      setCanvas('load')
      return
    }
    setMode(allowed === 'no' ? 'posters' : 'webgl')
    if (allowed === 'forced') setCanvas('load')
  }, [sticky, capture, bar])

  useEffect(() => {
    store.mode = mode
  }, [mode, store])

  useEffect(() => {
    if (canvas !== 'ready') canvasLive.current = false
  }, [canvas])

  // The canvas chunk waits for intent. On touch and small screens that is the first gesture; on a
  // desktop with a fine pointer it is the first gesture or, failing that, idle time after load, so
  // the scene is usually ready before the reader reaches step 01 and never competes with LCP.
  useEffect(() => {
    if (mode !== 'webgl' || canvas !== 'off' || capture !== null) return
    let done = false
    let idle = 0
    const events = ['wheel', 'scroll', 'pointerdown', 'touchstart', 'keydown'] as const
    const cleanup = () => {
      done = true
      for (const e of events) window.removeEventListener(e, go)
      window.removeEventListener('load', afterLoad)
      if (idle) (window.cancelIdleCallback ?? window.clearTimeout)(idle)
    }
    function go() {
      if (done) return
      cleanup()
      if (hasWebGL2()) setCanvas('load')
      else setMode('posters')
    }
    function afterLoad() {
      idle =
        typeof window.requestIdleCallback === 'function'
          ? window.requestIdleCallback(go, { timeout: 2500 })
          : window.setTimeout(go, 2500)
    }
    for (const e of events) window.addEventListener(e, go, { passive: true })
    const touchy = window.matchMedia('(pointer: coarse), (max-width: 760px)').matches
    if (!touchy) {
      if (document.readyState === 'complete') afterLoad()
      else window.addEventListener('load', afterLoad, { once: true })
    }
    return cleanup
  }, [mode, canvas, capture])

  // The strike: recoil on the scene layers and one cupel pulse, as a class the stylesheet animates
  // (and ignores under reduced motion). Whoever is drawing reports the crossing; this debounces it.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let last = -Infinity
    let timer = 0
    store.onStrike = () => {
      const now = performance.now()
      if (now - last < STRIKE_DEBOUNCE_MS) return
      last = now
      if (document.documentElement.dataset.motion !== 'full') return
      stage.classList.add(s.struck)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => stage.classList.remove(s.struck), 400)
    }
    return () => {
      store.onStrike = undefined
      window.clearTimeout(timer)
      stage.classList.remove(s.struck)
    }
  }, [store])

  // The scroll engine: sticky layouts only, and not while a poster is being captured.
  useEffect(() => {
    const track = trackRef.current
    const stage = stageRef.current
    if (!track || !stage || !sticky || capture !== null) return

    const hero = stage.querySelector<HTMLElement>('[data-hero]')
    const rail = stage.querySelector<HTMLElement>('[data-rail]')
    const caps = [...stage.querySelectorAll<HTMLElement>('[data-cap]')]
    const posters = [...stage.querySelectorAll<HTMLElement>('[data-poster]')]
    const w = writer()
    let top = 0
    let vh = 1
    let raf = 0
    let prevP = -1
    let step = -1

    const measure = () => {
      vh = stage.offsetHeight || window.innerHeight
      top = track.getBoundingClientRect().top + window.scrollY
    }

    const frame = () => {
      raf = 0
      // Screens scrolled into the track, and scene progress once the hero's hold is over.
      const y = (window.scrollY - top) / vh
      const p = clamp01((y - HOLD) / (STEPS * LEN))

      if (hero) {
        const out = smooth((y - 0.08) / 0.4)
        w.put(hero, 'opacity', (1 - out).toFixed(3))
        w.put(hero, 'transform', `translate3d(0,${(-out * 40).toFixed(1)}px,0)`)
        w.put(hero, 'pointerEvents', out > 0.5 ? 'none' : '')
      }

      if (rail) {
        const aside = smooth((p - RAIL_ASIDE[0]) / RAIL_FADE) * (1 - smooth((p - RAIL_ASIDE[1]) / RAIL_FADE))
        w.put(rail, 'opacity', (1 - aside).toFixed(3))
        w.put(rail, 'transform', `translate3d(0,${(-aside * 10).toFixed(1)}px,0)`)
      }

      store.target = p
      if (!canvasLive.current) {
        store.current = p
        if (prevP >= 0 && prevP < P_STRIKE && p >= P_STRIKE) store.onStrike?.()
      }
      prevP = p
      store.onChange?.()

      // One caption at a time: each fades out before the next fades in, so two sentences never
      // share the same place on screen. Step 01 arrives as the hero leaves.
      caps.forEach((el, i) => {
        const a = STEP_EDGES[i]!
        const b = STEP_EDGES[i + 1]!
        const fadeIn = i === 0 ? smooth((y - 0.5) / (HOLD - 0.5 + CAP_FADE * STEPS * LEN)) : smooth((p - a) / CAP_FADE)
        const fadeOut = i === STEPS - 1 ? 0 : smooth((p - (b - CAP_FADE)) / CAP_FADE)
        const o = fadeIn * (1 - fadeOut)
        w.put(el, 'opacity', o.toFixed(3))
        w.put(el, 'transform', `translate3d(0,${((1 - fadeIn) * 16 - fadeOut * 16).toFixed(1)}px,0)`)
      })

      // Posters stack in step order and each fades in over the one below it; everything under an
      // opaque frame is hidden, so the compositor holds one or two frames, not five.
      if (!canvasLive.current) {
        const o = posters.map((_, i) => (i === 0 ? 1 : smooth((p - (STEP_EDGES[i]! - POSTER_FADE)) / (2 * POSTER_FADE))))
        let cover = 0
        o.forEach((v, i) => {
          if (v >= 1) cover = i
        })
        posters.forEach((el, i) => {
          w.put(el, 'opacity', o[i]!.toFixed(3))
          w.put(el, 'visibility', i < cover || o[i]! <= 0 ? 'hidden' : 'visible')
        })
      }

      // The rail lights the rows each step reads (see [data-on] in sections/hero.tsx).
      let next = 0
      if (y >= 0.5) {
        next = STEPS
        for (let i = 0; i < STEPS; i++) if (p < STEP_EDGES[i + 1]!) {
          next = i + 1
          break
        }
      }
      if (next !== step) {
        step = next
        stage.dataset.step = String(step)
      }
    }

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }
    const onResize = () => {
      measure()
      schedule()
    }

    measure()
    frame()
    let retire = 0
    handOver.current = (live) => {
      // Once the canvas has faded in over them (~0.9s), the posters under it only cost memory.
      // Without it they take over again, from wherever the scroll is now, on the next frame.
      window.clearTimeout(retire)
      if (live) {
        retire = window.setTimeout(() => {
          if (canvasLive.current) for (const el of posters) w.put(el, 'visibility', 'hidden')
        }, 1000)
      }
      schedule()
    }
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(track)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(retire)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      handOver.current = null
      w.reset()
      delete stage.dataset.step
    }
  }, [sticky, capture, store])

  // Whether the stage is under the header, so the header can drop its fill for a scrim there and
  // keep it everywhere else (see the last rule in stage.module.css). Sticky, that is the whole
  // track; static, only the hero is dark enough to sit under a transparent header.
  useEffect(() => {
    const stage = stageRef.current
    const track = trackRef.current
    if (!stage || !track) return
    const hero = stage.querySelector<HTMLElement>('[data-hero]')
    const header = document.querySelector<HTMLElement>('.site-header')
    const under = sticky ? track : (hero ?? track)
    let raf = 0
    let over: boolean | null = null
    const update = () => {
      raf = 0
      const next = under.getBoundingClientRect().bottom > (header?.offsetHeight ?? 64)
      if (next === over) return
      over = next
      if (next) stage.dataset.over = ''
      else delete stage.dataset.over
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      delete stage.dataset.over
    }
  }, [sticky])

  // A poster capture: the frame alone, held at the step, with nothing drawn over it.
  useEffect(() => {
    if (capture === null) return
    const mid = (STEP_EDGES[capture - 1]! + STEP_EDGES[capture]!) / 2
    store.target = store.current = mid
    window.scrollTo(0, 0)
    const header = document.querySelector<HTMLElement>('.site-header')
    if (header) header.style.visibility = 'hidden'
    return () => {
      if (header) header.style.visibility = ''
    }
  }, [capture, store])

  const onReady = useCallback(() => {
    canvasLive.current = true
    setCanvas('ready')
    handOver.current?.(true)
  }, [])

  const onFail = useCallback((reason?: unknown) => {
    canvasLive.current = false
    try {
      sessionStorage.setItem(POSTERS_FLAG, 'posters')
    } catch {
      /* storage blocked: this visit still falls back */
    }
    if (process.env.NODE_ENV !== 'production') console.warn('[landing] 3D off, showing posters:', reason)
    setCanvas('off')
    setMode('posters')
    handOver.current?.(false)
  }, [])

  const trackStyle = { '--hold': HOLD, '--len': LEN, '--steps': STEPS } as CSSProperties

  return (
    <div ref={trackRef} className={s.track} style={trackStyle}>
      <div ref={stageRef} className={s.stage} data-mode={mode} data-capture={capture ?? undefined}>
        {children}
        <div className={s.canvas} data-state={canvas} aria-hidden="true">
          {bar && canvas !== 'off' ? (
            <CanvasBoundary onError={onFail}>
              <AssayCanvas
                bar={bar}
                store={store}
                onReady={onReady}
                onFail={onFail}
                poster={capture ?? undefined}
              />
            </CanvasBoundary>
          ) : null}
        </div>
        <div className={s.pulse} aria-hidden="true" />
        <div className={s.scrim} aria-hidden="true" />
      </div>
    </div>
  )
}
