/**
 * Watches the frame rate while the scene is actually moving, and steps down when the device can't
 * keep up: first to 1× resolution, then out of WebGL to the poster frames. The guard only ever sees
 * intervals between two consecutive animated frames, because a demand-driven canvas sits idle
 * between scrolls and that idle time is not a slow frame.
 *
 * Falling back is remembered by the stage, not here: onTooSlow reaches the canvas's onFail, and the
 * stage stores its own flag (POSTERS_FLAG in stage.tsx) so the rest of the visit stays on posters.
 */

const WINDOW = 45
const DROP_MS = 24
const FAIL_MS = 28

export interface PerfGuard {
  /** One interval, in ms, between two consecutive frames rendered while animating. */
  sample: (ms: number) => void
}

export function createPerfGuard(onDropResolution: () => void, onTooSlow: () => void): PerfGuard {
  const samples: number[] = []
  let dropped = false
  let done = false
  return {
    sample(ms) {
      if (done || !(ms > 0)) return
      samples.push(ms)
      if (samples.length < WINDOW) return
      const sorted = samples.slice().sort((a, b) => a - b)
      const median = sorted[WINDOW >> 1]!
      samples.length = 0
      if (!dropped) {
        if (median > DROP_MS) {
          dropped = true
          onDropResolution()
        }
      } else if (median > FAIL_MS) {
        done = true
        onTooSlow()
      }
    },
  }
}
