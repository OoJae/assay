/**
 * The one channel between the scroll and the 3D scene.
 *
 * The stage writes `target` from its ScrollTrigger; the canvas damps toward it and writes `current`.
 * Neither imports the other: the canvas sets `onChange` to its own invalidate(), so a scroll event
 * wakes a `frameloop="demand"` renderer without this module knowing R3F exists, and the stage sets
 * `onStrike` so the recoil and pulse fire from whichever renderer is showing (canvas or posters).
 */
export type StageMode = 'static' | 'posters' | 'webgl'

export interface ProgressStore {
  /** Scroll progress through the assay track, 0..1. Written by the stage. */
  target: number
  /** The damped progress the scene is showing. Written by the canvas (or mirrored from target in poster mode). */
  current: number
  mode: StageMode
  /** Set by the canvas to its invalidate(). */
  onChange?: () => void
  /** Set by the stage. Called once when `current` crosses P_STRIKE going forward (debounced by the caller). */
  onStrike?: () => void
}

/** Where the punch meets the bar, as scroll progress. The hallmark is visible from here on. */
export const P_STRIKE = 0.5

/** The five assay steps, as progress windows. Step i spans [STEP_EDGES[i], STEP_EDGES[i + 1]). */
export const STEP_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1] as const

export function createProgressStore(mode: StageMode = 'static'): ProgressStore {
  return { target: 0, current: 0, mode }
}
