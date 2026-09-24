import { Color, Mesh, MeshStandardMaterial, PlaneGeometry, type Texture } from 'three'
import { STREAK_ASPECT } from './textures'

/**
 * The bench: a pool of touchstone under the bar, fading into the page so it has no edge, with the
 * streak of a metal rubbed across it. Both are transparent and drawn first among the transparent
 * things (renderOrder), under the contact shadows.
 */
export interface BenchParts {
  meshes: Mesh[]
  setPortrait: (portrait: boolean) => void
  dispose: () => void
}

export function createBench(opts: { stone: Texture; streak: Texture }): BenchParts {
  const stoneGeo = new PlaneGeometry(11, 11)
  stoneGeo.rotateX(-Math.PI / 2)
  const stoneMat = new MeshStandardMaterial({
    map: opts.stone,
    transparent: true,
    depthWrite: false,
    roughness: 0.78,
    metalness: 0,
  })
  const stone = new Mesh(stoneGeo, stoneMat)
  stone.renderOrder = -3

  const streakGeo = new PlaneGeometry(1.05, 1.05 / STREAK_ASPECT)
  streakGeo.rotateX(-Math.PI / 2)
  /* Metal left on the stone: a sterling deposit, matte and barely metallic. Powdered metal scatters
     light instead of mirroring the room, so the strokes stay a quiet grey at every turn of the
     environment rather than flashing like a polished object. */
  const streakMat = new MeshStandardMaterial({
    color: new Color('#B9BEC4'),
    metalness: 0.15,
    roughness: 0.82,
    opacity: 0.7,
    alphaMap: opts.streak,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  const streak = new Mesh(streakGeo, streakMat)
  streak.renderOrder = -2
  streak.position.y = 0.0004

  return {
    meshes: [stone, streak],
    /* In front of the bar and off to one side in landscape; beside it, running with it, in portrait. */
    setPortrait(portrait) {
      if (portrait) {
        streak.position.set(1.18, 0.0004, 0.9)
        streak.rotation.y = Math.PI / 2 - 0.12
      } else {
        streak.position.set(1.0, 0.0004, 1.25)
        streak.rotation.y = 0.16
      }
    },
    dispose() {
      stoneGeo.dispose()
      stoneMat.dispose()
      streakGeo.dispose()
      streakMat.dispose()
    },
  }
}
