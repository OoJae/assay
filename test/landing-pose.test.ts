import { describe, it, expect } from 'vitest'
import { P_STRIKE, STEP_EDGES } from '../web/app/_landing/progress.js'
import { BAR, CONTACT, POSTER_PROGRESS, PUNCH_PARKED, pose, type Pose } from '../web/app/_landing/scene/pose.js'

/**
 * The assay scene's choreography, offline.
 *
 * pose() is the whole of what the 3D scene does with scroll progress, so it is checked here without
 * a GPU. Two promises matter to the page around it. The first: the scene never jumps, because a
 * scrubbed scene that teleports on a slow scroll reads as a bug. The second: the punch lands on the
 * bar exactly at P_STRIKE, the progress at which the stage fires the recoil and the pulse. If the two
 * drifted apart, the page would flinch before or after the metal was struck.
 */

const STEP = 1e-3
const FIELDS = ['cam', 'drift', 'env', 'punch', 'hallmark', 'split', 'hop'] as const satisfies ReadonlyArray<keyof Pose>

/**
 * The fastest any field may move per 1e-3 of progress. The fastest motion is the punch leaving
 * (about 0.17 units per step), so 0.2 passes every intended move and fails any jump: the smallest
 * real discontinuity would be the hallmark switching on (1) or the punch teleporting (≥ 0.3).
 */
const MAX_STEP = 0.2

const samples = Array.from({ length: Math.round(1 / STEP) + 1 }, (_, i) => Math.min(1, i * STEP))

describe('pose(): the assay scene as a function of scroll progress', () => {
  it('uses the same strike progress as the stage', () => {
    expect(CONTACT).toBe(P_STRIKE)
  })

  it('is finite everywhere on 0..1, and clamps outside it', () => {
    for (const p of samples) {
      const q = pose(p)
      for (const k of FIELDS) expect(Number.isFinite(q[k]), `${k} at ${p}`).toBe(true)
    }
    expect(pose(-0.5)).toEqual(pose(0))
    expect(pose(1.5)).toEqual(pose(1))
    expect(pose(Number.NaN)).toEqual(pose(0))
  })

  it('is continuous: no field moves more than MAX_STEP between neighbouring samples', () => {
    const worst: Record<string, { d: number; at: number }> = {}
    let prev = pose(0)
    for (const p of samples.slice(1)) {
      const q = pose(p)
      for (const k of FIELDS) {
        const d = Math.abs(q[k] - prev[k])
        if (!worst[k] || d > worst[k].d) worst[k] = { d, at: p }
      }
      prev = q
    }
    for (const k of FIELDS) expect(worst[k]!.d, `${k} jumps by ${worst[k]!.d} at ${worst[k]!.at}`).toBeLessThanOrEqual(MAX_STEP)
  })

  it('lands the punch on the bar exactly at P_STRIKE, and never before', () => {
    const faceAt = (p: number) => BAR.height + pose(p).punch
    expect(faceAt(P_STRIKE)).toBe(BAR.height)
    for (const p of samples) {
      expect(pose(p).punch, `punch below the top face at ${p}`).toBeGreaterThanOrEqual(0)
      if (p < P_STRIKE) expect(pose(p).punch, `contact before the strike, at ${p}`).toBeGreaterThan(0)
    }
    // Falling, and fastest, just before contact: ease-in, the strike is not a drift.
    const a = pose(P_STRIKE - 0.004).punch
    const b = pose(P_STRIKE - 0.002).punch
    expect(a).toBeGreaterThan(b)
    expect(a - b).toBeGreaterThan(pose(P_STRIKE - 0.02).punch - pose(P_STRIKE - 0.018).punch)
    // Out of the scene before it begins and after it ends.
    expect(pose(STEP_EDGES[2]).punch).toBe(PUNCH_PARKED)
    expect(pose(STEP_EDGES[4]).punch).toBe(PUNCH_PARKED)
  })

  it('shows no hallmark until the punch has landed, and all of it once the punch lifts', () => {
    let last = 0
    for (const p of samples) {
      const h = pose(p).hallmark
      if (p <= P_STRIKE) expect(h, `gold before the strike, at ${p}`).toBe(0)
      expect(h).toBeGreaterThanOrEqual(last)
      last = h
      // Whenever any gold shows, the punch is either on it (hiding the fade) or has struck it.
      if (h > 0 && h < 1) expect(pose(p).punch, `gold fading in under a lifted punch at ${p}`).toBe(0)
    }
    expect(pose(P_STRIKE + 0.02).hallmark).toBe(1)
    expect(pose(1).hallmark).toBe(1)
  })

  it('divides only inside the divide window, and settles whole', () => {
    for (const p of samples) {
      const s = pose(p).split
      if (p < STEP_EDGES[3]) expect(s, `split before the divide, at ${p}`).toBe(0)
      if (p >= 0.7) expect(s, `still moving after the snap, at ${p}`).toBe(1)
    }
    // The snap overshoots before it settles: a break, not a slide.
    const peak = Math.max(...samples.filter((p) => p >= STEP_EDGES[3] && p < 0.7).map((p) => pose(p).split))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(1.2)
  })

  it('takes each poster inside its own step, at a still camera, with the strike already struck', () => {
    expect(POSTER_PROGRESS).toHaveLength(5)
    POSTER_PROGRESS.forEach((p, i) => {
      expect(p).toBeGreaterThanOrEqual(STEP_EDGES[i]!)
      expect(p).toBeLessThan(STEP_EDGES[i + 1]!)
      expect(pose(p).cam, `poster ${i + 1} mid-move`).toBe(i)
    })
    const strike = pose(POSTER_PROGRESS[2])
    expect(strike.hallmark).toBe(1)
    expect(strike.punch).toBeGreaterThan(0.2) // lifted clear, so the mark shows
    expect(strike.punch).toBeLessThan(1) // and still in frame, so it reads as just struck
    expect(pose(POSTER_PROGRESS[3]).split).toBe(1)
  })
})
