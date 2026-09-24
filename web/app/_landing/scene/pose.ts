/**
 * The assay as a pure function of scroll progress.
 *
 * Everything the scene moves is decided here, as plain numbers, so the choreography can be tested
 * without a GPU (test/landing-pose.test.ts) and so the live canvas and the poster capture show the
 * same frame for the same progress. The module imports nothing: the test runs it in Node, and the
 * renderer only reads what it returns.
 *
 * Windows (STEP_EDGES in ../progress.ts): 0–.2 weigh · .2–.4 read the multiplier · .4–.6 strike
 * (contact at .5) · .6–.8 divide · .8–1 re-fetch.
 */

/**
 * Where the punch face meets the bar. The same number as P_STRIKE in ../progress.ts, repeated so
 * this file stays import-free; the pose test fails if the two ever differ.
 */
export const CONTACT = 0.5

/** The bar in scene units: 4 long (x), 0.45 tall (y), 1.3 deep (z), resting on the bench at y = 0. */
export const BAR = { length: 4, height: 0.45, depth: 1.3 } as const

/** How high the punch waits, above the bar's top face: just out of the strike framing in both orientations. */
export const PUNCH_PARKED = 3.2

export interface Pose {
  /** Camera keyframe, 0..4: a whole number while a step holds its framing, fractional between. */
  cam: number
  /** A slow orbit, in radians, so the bar keeps turning a little while a framing holds. */
  drift: number
  /** The environment's turn about y, in radians: the highlight that travels over the stamps. */
  env: number
  /** Height of the punch face above the bar's top face. 0 is contact, and it is never below 0. */
  punch: number
  /** Opacity of the gold inlay, 0..1. Zero until the punch has landed. */
  hallmark: number
  /** How far the pieces have come apart, 0..1. The snap overshoots 1 briefly and settles on it. */
  split: number
  /** 0..1 and back while the pieces break apart: the lift and tilt of the break. */
  hop: number
}

const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t)
const span = (p: number, a: number, b: number) => clamp01((p - a) / (b - a))

type Ease = (t: number) => number
const linear: Ease = (t) => t
const smooth: Ease = (t) => t * t * (3 - 2 * t)
const smoother: Ease = (t) => t * t * t * (t * (t * 6 - 15) + 10)
const inCubic: Ease = (t) => t * t * t
const outCubic: Ease = (t) => 1 - (1 - t) ** 3
const inOutSine: Ease = (t) => (1 - Math.cos(Math.PI * t)) / 2
/** Back-out: passes 1 by about 10% and returns, the "snap" of a scored bar parting. */
const backOut: Ease = (t) => {
  const s = 1.7
  const u = t - 1
  return 1 + (s + 1) * u * u * u + s * u * u
}

/** Keys of [progress, value, ease into this key]. Continuous by construction: each span starts where the last ended. */
type Track = ReadonlyArray<readonly [number, number, Ease]>

function sample(track: Track, p: number): number {
  const first = track[0]!
  if (p <= first[0]) return first[1]
  for (let i = 1; i < track.length; i++) {
    const [b, vb, ease] = track[i]!
    if (p <= b) {
      const [a, va] = track[i - 1]!
      return va + (vb - va) * ease((p - a) / (b - a))
    }
  }
  return track[track.length - 1]![1]
}

/**
 * The camera holds a framing across the middle of each step and travels between them, so every
 * caption is read against a still composition and every poster (a moment inside a hold) matches
 * the live frame. [start, end] of each hold, in progress.
 */
const HOLDS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.13],
  [0.26, 0.35],
  [0.45, 0.57],
  [0.66, 0.77],
  [0.88, 1],
]

function camAt(p: number): number {
  for (let i = 0; i < HOLDS.length; i++) {
    const [a, b] = HOLDS[i]!
    if (p > b) continue
    if (p >= a || i === 0) return i
    const prevEnd = HOLDS[i - 1]![1]
    return i - 1 + smoother((p - prevEnd) / (a - prevEnd))
  }
  return HOLDS.length - 1
}

/**
 * The punch: it comes down and settles just above the bar, draws back a little, then falls fast
 * (ease-in, so it is quickest at the instant it lands) and meets the top face exactly at CONTACT.
 * It stays on the metal while the mark is struck, springs clear, and hovers a moment over the gold
 * it left, so "struck" is a pose the reader can stop on, then leaves before the divide.
 */
const DWELL_END = 0.512
const PUNCH: Track = [
  [0.4, PUNCH_PARKED, linear],
  [0.455, 0.62, outCubic],
  [0.472, 0.8, inOutSine],
  [CONTACT, 0, inCubic],
  [DWELL_END, 0, linear],
  [0.53, 0.3, outCubic],
  [0.575, 0.55, inOutSine],
  [0.64, PUNCH_PARKED, inCubic],
]

/**
 * The environment's turn, relative to the resting turn in engine.ts. Each hold's value was picked by
 * rendering that hold at a sweep of turns in both orientations: the ×4 lies in a bright band while
 * the multiplier is read, and in shade for the strike, so the gold lands on dark metal the way a
 * streak shows on a touchstone. Between holds the highlight travels over the stamps, and during the
 * re-fetch it passes over the divided pieces one after another, like a reader going down a list.
 */
const ENV: Track = [
  [0, 0, linear],
  [0.14, 0, linear],
  [0.26, 1.35, smoother],
  [0.35, 1.5, smoother],
  [0.45, 1.25, smoother],
  [0.6, 1.25, linear],
  [0.68, 0.8, smoother],
  [0.8, 0.8, linear],
  [1, 2.3, smoother],
]

/** The divide: the pieces snap apart along the scored lines, inside the divide window. */
const SNAP: readonly [number, number] = [0.62, 0.68]
const HOP: readonly [number, number] = [0.615, 0.675]

export function pose(progress: number): Pose {
  const p = clamp01(Number.isFinite(progress) ? progress : 0)
  return {
    cam: camAt(p),
    drift: (p - 0.5) * 0.16,
    env: sample(ENV, p),
    punch: sample(PUNCH, p),
    hallmark: smooth(span(p, CONTACT, DWELL_END)),
    split: p <= SNAP[0] ? 0 : p >= SNAP[1] ? 1 : backOut(span(p, SNAP[0], SNAP[1])),
    hop: Math.sin(Math.PI * span(p, HOP[0], HOP[1])),
  }
}

/**
 * The frozen progress each poster is rendered at, one per step. Each sits inside its step's camera
 * hold, at the step's midpoint, except the strike: its midpoint is the instant of contact, when the
 * punch hides the mark it is striking, so its poster is taken a moment later, with the gold showing
 * and the punch lifting clear.
 */
export const POSTER_PROGRESS = [0.1, 0.3, 0.548, 0.7, 0.92] as const
