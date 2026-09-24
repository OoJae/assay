'use client'

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { loadRuntime, loadedRuntime, notifyPathname } from './nav'

/**
 * Starts the motion runtime once the page is interactive, and tells it about route changes.
 *
 * Kept to hooks and a dynamic import so it costs about a kilobyte on first load. It renders its
 * children untouched: the site is complete without it, and nothing here can delay a paint.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const lastPath = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const boot = () => {
      loadRuntime()
        .then((rt) => {
          if (!cancelled) rt.start()
        })
        .catch(() => {
          /* No runtime: the page stays in its painted, static state, which is complete. */
        })
    }
    // Idle, not immediately: hydration and the first input get the main thread first.
    const ric = typeof window.requestIdleCallback === 'function'
    const idle = ric ? window.requestIdleCallback(boot, { timeout: 2000 }) : window.setTimeout(boot, 200)

    // The pre-paint script in the layout sets data-motion once; this keeps it true if the
    // preference changes while the page is open, and lets Lenis follow.
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotionPref = () => {
      document.documentElement.dataset.motion = mq.matches ? 'reduced' : 'full'
      loadedRuntime()?.sync()
    }
    mq.addEventListener('change', onMotionPref)

    return () => {
      cancelled = true
      if (ric) window.cancelIdleCallback(idle)
      else window.clearTimeout(idle)
      mq.removeEventListener('change', onMotionPref)
      loadedRuntime()?.stop()
    }
  }, [])

  // A layout effect: it runs once the new route's DOM is committed and before paint, which is the
  // moment a view transition waiting in TransitionLink may capture the new frame.
  useLayoutEffect(() => {
    // The ref survives Strict Mode's double-invoked effects, so the first mount is never mistaken
    // for a navigation.
    if (lastPath.current === pathname) return
    const initial = lastPath.current === null
    lastPath.current = pathname
    notifyPathname(pathname)
    if (initial) return

    const h = document.documentElement
    const mode = h.dataset.nav === 'vt' ? 'vt' : 'arriving'
    h.dataset.nav = mode
    loadedRuntime()?.onRoute()
    const t = window.setTimeout(() => {
      if (h.dataset.nav === mode) delete h.dataset.nav
    }, mode === 'vt' ? 900 : 600)
    return () => window.clearTimeout(t)
  }, [pathname])

  return children
}
