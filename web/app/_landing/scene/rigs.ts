import type { PerspectiveCamera } from 'three'

/**
 * Where the camera stands for each of the five steps, in two orientations, and how the two blend.
 *
 * LANDSCAPE: the bar lies along x, seen three-quarters from the front at a low pitch, and sits to
 * the right of centre because the captions take the left columns. PORTRAIT: the bar group turns
 * -90° so its long axis runs up the screen, the camera looks down steeply, and the bar sits in the
 * top ~60% because the captions sit below it. Between aspect 0.8 and 1.2 everything interpolates,
 * so a window being resized never jumps.
 *
 * A rig does not store a camera distance. It names the extent that must be visible around its
 * target (fit: width × height in scene units), and the distance is solved from the field of view
 * at the current aspect, so the same framing holds on any screen. The subject is then moved off
 * centre with a lens shift (the projection's principal point) rather than by aiming the camera
 * away from it, so the bar keeps its true perspective wherever it sits in the frame.
 */

type V3 = readonly [number, number, number]

export interface Rig {
  /** Look-at point, in the bar group's own frame (it turns with the bar in portrait). */
  target: V3
  /** Orbit about y, degrees; 0 looks from +z (the bar's front) and negative comes round from the left. */
  yaw: number
  /** Degrees above the bench. */
  pitch: number
  /** Width × height, in scene units, kept inside the frame around the target. */
  fit: readonly [number, number]
}

/** The part of the frame the subject is fitted into: centre and half-size, in normalised device coordinates. */
interface Window {
  cx: number
  cy: number
  rx: number
  ry: number
}

export const FOV = 30

/* 01 weigh · 02 read the multiplier · 03 strike · 04 divide · 05 re-fetch */
export const LANDSCAPE: readonly Rig[] = [
  { target: [0.1, 0.2, 0.1], yaw: -30, pitch: 18, fit: [3.95, 1.6] },
  { target: [-0.5, 0.45, -0.2], yaw: -12, pitch: 40, fit: [2.4, 1.35] },
  { target: [0.05, 0.8, 0.28], yaw: -22, pitch: 21, fit: [2.6, 2.1] },
  { target: [0, 0.25, 0], yaw: -30, pitch: 31, fit: [5.3, 2.2] },
  { target: [0, 0.2, 0.05], yaw: -14, pitch: 54, fit: [5.5, 3.0] },
]

export const PORTRAIT: readonly Rig[] = [
  { target: [0, 0.2, 0], yaw: 14, pitch: 55, fit: [2.0, 3.7] },
  { target: [-0.6, 0.45, 0], yaw: 8, pitch: 60, fit: [2.1, 1.8] },
  { target: [-0.3, 0.9, 0], yaw: 18, pitch: 38, fit: [2.3, 3.0] },
  { target: [0, 0.25, 0], yaw: 16, pitch: 60, fit: [2.2, 5.0] },
  { target: [0, 0.2, 0], yaw: 8, pitch: 68, fit: [2.4, 5.4] },
]

const LAND_WINDOW: Window = { cx: 0.36, cy: -0.02, rx: 0.6, ry: 0.78 }
const PORT_WINDOW: Window = { cx: 0, cy: 0.34, rx: 0.9, ry: 0.56 }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 1 in landscape, 0 in portrait, blended between aspect 0.8 and 1.2. */
export function landscapeWeight(aspect: number): number {
  return smoothstep(0.8, 1.2, aspect)
}

/** The bar group's turn about y: 0 in landscape, -90° in portrait, so its left end is at the top. */
export function barTurn(land: number): number {
  return (-Math.PI / 2) * (1 - land)
}

function mix(a: Rig, b: Rig, t: number): Rig {
  return {
    target: [lerp(a.target[0], b.target[0], t), lerp(a.target[1], b.target[1], t), lerp(a.target[2], b.target[2], t)],
    yaw: lerp(a.yaw, b.yaw, t),
    pitch: lerp(a.pitch, b.pitch, t),
    fit: [lerp(a.fit[0], b.fit[0], t), lerp(a.fit[1], b.fit[1], t)],
  }
}

function at(rigs: readonly Rig[], cam: number): Rig {
  const last = rigs.length - 1
  const c = Math.min(last, Math.max(0, cam))
  const i = Math.min(last - 1, Math.floor(c))
  return mix(rigs[i]!, rigs[i + 1]!, c - i)
}

/**
 * Put the camera where pose `cam` (0..4, see pose.ts) and `drift` (radians) say, for a viewport of
 * `aspect`. Writes position, orientation and the shifted projection.
 */
export function placeCamera(camera: PerspectiveCamera, cam: number, drift: number, aspect: number): void {
  const land = landscapeWeight(aspect)
  const r = mix(at(PORTRAIT, cam), at(LANDSCAPE, cam), land)
  const w: Window = {
    cx: lerp(PORT_WINDOW.cx, LAND_WINDOW.cx, land),
    cy: lerp(PORT_WINDOW.cy, LAND_WINDOW.cy, land),
    rx: lerp(PORT_WINDOW.rx, LAND_WINDOW.rx, land),
    ry: lerp(PORT_WINDOW.ry, LAND_WINDOW.ry, land),
  }

  // The target turns with the bar.
  const turn = barTurn(land)
  const c = Math.cos(turn)
  const s = Math.sin(turn)
  const [lx, ly, lz] = r.target
  const tx = lx * c + lz * s
  const tz = -lx * s + lz * c

  const tanV = Math.tan(((FOV / 2) * Math.PI) / 180)
  const tanH = tanV * aspect
  const dist = Math.max(r.fit[0] / 2 / (tanH * w.rx), r.fit[1] / 2 / (tanV * w.ry))
  const yaw = ((r.yaw * Math.PI) / 180) + drift
  const pitch = (r.pitch * Math.PI) / 180

  camera.fov = FOV
  camera.aspect = aspect
  camera.position.set(
    tx + dist * Math.sin(yaw) * Math.cos(pitch),
    ly + dist * Math.sin(pitch),
    tz + dist * Math.cos(yaw) * Math.cos(pitch),
  )
  camera.lookAt(tx, ly, tz)
  camera.updateProjectionMatrix()
  // Lens shift: the look-at point lands at (cx, cy) in NDC instead of the centre.
  const e = camera.projectionMatrix.elements
  e[8] = -w.cx
  e[9] = -w.cy
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
}
