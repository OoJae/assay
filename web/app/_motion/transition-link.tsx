'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ComponentProps } from 'react'
import { loadedRuntime, markPending, pathnameCommitted, prefersReducedMotion, samePath } from './nav'

type Props = Omit<ComponentProps<typeof Link>, 'href' | 'onNavigate'> & { href: string }

/** How long a view transition may hold the old frame while the next route renders. */
const CAP_MS = 450

/**
 * A Link whose route change is drawn as "the scribe": the header's sterling rail scribes across
 * while the next page fades up (see the view-transition rules in globals.css).
 *
 * Built on Link's onNavigate, so it only ever intercepts what Link itself would navigate: a
 * cmd- or ctrl-click, a middle click and "open in new tab" stay native. Where the View Transitions
 * API is missing or motion is reduced it is a plain Link, and the arrival fade in MotionProvider
 * still marks the change.
 */
export function TransitionLink({ href, replace, scroll, ...rest }: Props) {
  const router = useRouter()

  return (
    <Link
      href={href}
      replace={replace}
      scroll={scroll}
      onNavigate={(e) => {
        const target = new URL(href, window.location.href)
        // Same page (a hash, or the page you are on): nothing changes to transition between.
        if (samePath(target.pathname, window.location.pathname)) return
        if (typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
          markPending()
          return
        }
        e.preventDefault()
        const h = document.documentElement
        loadedRuntime()?.pauseScroll()
        let committed = false
        const vt = document.startViewTransition(async () => {
          // Set inside the callback, i.e. after the old frame was captured, so only the new frame
          // carries the lit rail that ::view-transition-new(streak-rail) scribes in.
          h.dataset.nav = 'vt'
          if (replace) router.replace(href, { scroll: scroll ?? true })
          else router.push(href, { scroll: scroll ?? true })
          committed = (await pathnameCommitted(target.pathname, CAP_MS)) === 'committed'
        })
        // `ready` rejects when the browser skips a transition (a second click starts another one);
        // that is expected, and the navigation itself still happens.
        vt.ready.catch(() => {})
        vt.finished
          .catch(() => {})
          .then(() => {
            // A slow route outlived the cap: the transition played over the old page, so hand the
            // rest to the no-transition path (rail pulse now, arrival fade on commit).
            if (!committed && h.dataset.nav === 'vt') markPending()
            // Never leave Lenis stopped: a stopped Lenis clips the page and nothing scrolls.
            loadedRuntime()?.onRoute()
          })
      }}
      {...rest}
    />
  )
}
