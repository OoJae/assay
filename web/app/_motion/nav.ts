/**
 * Navigation state shared by TransitionLink and MotionProvider, with no animation code in it.
 *
 * It lives apart from runtime.ts so the links in the header can use it without pulling gsap and
 * Lenis into the first-load bundle: the runtime is an async chunk, and until it arrives these
 * functions simply have nothing to pause.
 *
 * `html[data-nav]` drives the route CSS in globals.css:
 *   pending   a soft navigation is in flight with no view transition; the header rail pulses
 *   vt        a view transition is running; the rail is lit so the scribe has something to draw
 *   arriving  a soft navigation just committed without a view transition; <main> fades up
 */
import type * as Runtime from './runtime'

type RuntimeModule = typeof Runtime

let runtimePromise: Promise<RuntimeModule> | null = null
let runtime: RuntimeModule | null = null

/** The motion runtime, loaded once. Every caller shares the same chunk request. */
export function loadRuntime(): Promise<RuntimeModule> {
  runtimePromise ??= import('./runtime').then((m) => (runtime = m))
  return runtimePromise
}

/** The runtime if it has already loaded, so a click never waits on a chunk. */
export function loadedRuntime(): RuntimeModule | null {
  return runtime
}

export function prefersReducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduced'
}

/** Normalised so '/f/A%20B' and '/f/A B' compare equal; usePathname() is not consistent about it. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      p = decodeURI(p)
    } catch {
      /* keep it as given */
    }
    return p.length > 1 ? p.replace(/\/+$/, '') : p
  }
  return norm(a) === norm(b)
}

type Waiter = { path: string; done: () => void }
const waiters = new Set<Waiter>()

/**
 * Resolves when `path` has committed to the DOM, or after `capMs`, whichever is first.
 *
 * The cap is what keeps a view transition from freezing the page: the browser holds the old frame
 * until this settles, and a dynamic route like /f/[id] can take seconds to render on a cold start.
 */
export function pathnameCommitted(path: string, capMs: number): Promise<'committed' | 'capped'> {
  return new Promise((resolve) => {
    const w: Waiter = {
      path,
      done: () => {
        clearTimeout(timer)
        waiters.delete(w)
        resolve('committed')
      },
    }
    const timer = setTimeout(() => {
      waiters.delete(w)
      resolve('capped')
    }, capMs)
    waiters.add(w)
  })
}

/** Called by MotionProvider from a layout effect, i.e. after the new route's DOM is in place. */
export function notifyPathname(path: string): void {
  for (const w of [...waiters]) if (samePath(w.path, path)) w.done()
}

let pendingTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Marks a soft navigation as in flight. Cleared by the next committed pathname, or after 8s so a
 * navigation that never commits (an error, a cancelled click) cannot leave the rail pulsing.
 */
export function markPending(): void {
  const h = document.documentElement
  h.dataset.nav = 'pending'
  clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    if (h.dataset.nav === 'pending') delete h.dataset.nav
  }, 8000)
}
