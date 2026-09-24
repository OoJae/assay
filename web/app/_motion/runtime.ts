/**
 * The motion runtime: gsap, ScrollTrigger, SplitText and Lenis, in one async chunk.
 *
 * Nothing imports this module statically. It arrives through loadRuntime() in ./nav after
 * hydration, so no page's first paint or LCP waits on ~55 KB of animation code, and a page whose
 * runtime never loads is still complete: every reveal starts from the painted state.
 *
 * @gsap/react's useGSAP is not used here for the same reason: it imports gsap at module scope,
 * which would put gsap in the first-load bundle of every page that renders a Reveal. The callers
 * get the same guarantee from gsap.context(): everything created inside one is reverted by one
 * call, which they make on unmount.
 */
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import Lenis from 'lenis'

gsap.registerPlugin(ScrollTrigger, SplitText)
// A phone's URL bar showing and hiding resizes the viewport on every scroll direction change;
// refreshing every trigger for that is a visible hitch.
ScrollTrigger.config({ ignoreMobileResize: true })

export { gsap, ScrollTrigger, SplitText }

let started = false
let lenis: Lenis | null = null
const tick = (time: number) => lenis?.raf(time * 1000)
const refresh = () => ScrollTrigger.refresh()

function headerHeight(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h'))
  return Number.isFinite(v) ? v : 64
}

/**
 * Smooth scrolling only where it is an improvement: a mouse or trackpad, with motion allowed.
 * Touch keeps native scrolling (syncTouch off), which is already smooth and which users expect to
 * feel exactly like every other page on their phone.
 */
function wantsLenis(): boolean {
  return (
    document.documentElement.dataset.motion !== 'reduced' &&
    window.matchMedia('(pointer: fine)').matches
  )
}

function createLenis(): void {
  if (lenis) return
  lenis = new Lenis({
    autoRaf: false,
    lerp: 0.12,
    syncTouch: false,
    // Same-page anchors land below the sticky header, matching scroll-margin-top in globals.css.
    anchors: { offset: -(headerHeight() + 16) },
    // A link to another route kills any inertia first, so it cannot fight Next's scroll-to-top.
    stopInertiaOnNavigate: true,
    // Code blocks and wide tables scroll sideways on their own; smoothing the wheel over them
    // would swallow the horizontal gesture.
    prevent: (node) => !!node.closest?.('pre,.tscroll,[data-lenis-prevent]'),
  })
  lenis.on('scroll', ScrollTrigger.update)
  gsap.ticker.add(tick)
}

function destroyLenis(): void {
  if (!lenis) return
  gsap.ticker.remove(tick)
  lenis.destroy()
  lenis = null
}

/** Idempotent: Strict Mode and a remounted provider may both call it. */
export function start(): void {
  if (started) return
  started = true
  // Lenis drives the frame, so gsap must not "catch up" after a slow one: a skipped frame would
  // turn into a jump in every scrubbed animation.
  gsap.ticker.lagSmoothing(0)
  if (wantsLenis()) createLenis()
  // Trigger positions are measured once; web fonts and late images move them.
  document.fonts?.ready.then(refresh).catch(() => {})
  if (document.readyState !== 'complete') window.addEventListener('load', refresh, { once: true })
}

/** Tears everything down. Only the provider's unmount calls it, which in production is never. */
export function stop(): void {
  if (!started) return
  started = false
  window.removeEventListener('load', refresh)
  destroyLenis()
  gsap.ticker.lagSmoothing(500, 33)
}

/** Re-evaluates Lenis after the reduced-motion preference changes while the page is open. */
export function sync(): void {
  if (!started) return
  if (wantsLenis()) createLenis()
  else destroyLenis()
  refresh()
}

export function getLenis(): Lenis | null {
  return lenis
}

/** Freezes smooth scrolling for a route change, so inertia cannot carry into the next page. */
export function pauseScroll(): void {
  lenis?.stop()
}

/**
 * After a route commits: restart Lenis (its start() re-reads the scroll position Next just set),
 * re-measure the new document, and re-measure every trigger. Deferred one frame so the new page
 * has laid out.
 */
export function onRoute(): void {
  requestAnimationFrame(() => {
    if (lenis) {
      lenis.resize()
      lenis.start()
    }
    refresh()
  })
}

/**
 * Reveals a heading line by line as it scrolls into view. Returns the revert.
 *
 * Only for headings that start below the fold: one already on screen (the hero thesis, a page's
 * h1, anything the reader scrolled to before this chunk arrived) is left exactly as painted, so
 * LCP never waits on JS and nothing visible ever blinks out to animate back in.
 */
export function reveal(el: HTMLElement): () => void {
  if (el.getBoundingClientRect().top < window.innerHeight * 0.85) return () => {}
  const reduced = document.documentElement.dataset.motion === 'reduced'
  // A fresh vars object per tween: an autoSplit re-split creates a second one.
  const scrollTrigger = () => ({ trigger: el, start: 'top 85%', once: true })
  const ctx = gsap.context(() => {
    if (reduced) {
      gsap.from(el, { opacity: 0, duration: 0.6, ease: 'power1.out', scrollTrigger: scrollTrigger() })
      return
    }
    SplitText.create(el, {
      type: 'lines',
      mask: 'lines',
      linesClass: 'rv-line',
      autoSplit: true,
      aria: 'auto',
      // Returned so autoSplit can carry the tween's progress across a re-split on resize.
      onSplit: (self) =>
        gsap.from(self.lines, {
          yPercent: 100,
          duration: 1,
          ease: 'expo.out',
          stagger: 0.08,
          scrollTrigger: scrollTrigger(),
        }),
    })
  })
  return () => ctx.revert()
}
