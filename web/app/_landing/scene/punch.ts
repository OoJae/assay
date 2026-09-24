import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type Texture,
} from 'three'
import { HALLMARK_W } from './bar'
import { BAR, PUNCH_PARKED, type Pose } from './pose'

/**
 * The hallmarking punch: a steel die whose face is the hallmark's cartouche, so what it leaves in
 * the metal is exactly its own face. Above the face it flares into a block, and the block narrows
 * into a round shank that runs up out of the frame, the silhouette of a die held in a press. The
 * face is at y = 0 of the die's frame, so placing it at the bar's top face plus pose.punch puts
 * metal on metal exactly when pose.punch is 0.
 *
 * The first cut was a straight extrusion of the cartouche. On screen it read as a grey slab, not a
 * tool: a flat-sided prism reflects one band of the room per face. Each part here is tilted or
 * curved differently (the face chamfer, the taper, the block, the shoulder cone, the round shank),
 * so each catches a different height of the studio and the die reads as machined steel. It is one
 * lofted geometry and one draw call, and hidden altogether while parked.
 */

/** A hair larger than the hallmark, so the face covers the mark while it is being struck. */
const FACE_W = HALLMARK_W + 0.035
const FACE_D = HALLMARK_W / 4 + 0.035
/** Long enough that the shank's end never enters any rig's framing, even at the parked height. */
const LENGTH = 6
/** Points on each rounded corner. The shank is four of these quarter circles meeting. */
const ARC = 10

/** One cross-section: a rounded rectangle of half-extents hw × hd and corner radius r, at height y. */
type Station = readonly [y: number, hw: number, hd: number, r: number]

const FW = FACE_W / 2
const FD = FACE_D / 2
const SHANK = 0.17
const PROFILE: readonly Station[] = [
  [0, FW - 0.012, FD - 0.012, 0.02], // the face, a chamfer smaller than the neck
  [0.012, FW, FD, 0.03],
  [0.1, FW, FD, 0.03], // the neck that carries the mark
  [0.22, 0.5, 0.2, 0.06], // the taper up to the block
  [0.72, 0.5, 0.2, 0.06],
  [0.745, 0.485, 0.185, 0.05], // the block's top edge, broken
  [1.0, SHANK, SHANK, SHANK], // the shoulder, closing to the round shank
  [LENGTH, SHANK, SHANK, SHANK],
]

function ring([y, hw, hd, r]: Station): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = []
  const cx = hw - r
  const cz = hd - r
  const corners: ReadonlyArray<readonly [number, number]> = [
    [cx, cz],
    [-cx, cz],
    [-cx, -cz],
    [cx, -cz],
  ]
  corners.forEach(([ox, oz], q) => {
    for (let k = 0; k < ARC; k++) {
      const a = (Math.PI / 2) * (q + k / (ARC - 1))
      pts.push([ox + r * Math.cos(a), y, oz + r * Math.sin(a)])
    }
  })
  return pts
}

/**
 * Each band between two stations gets its own vertices, so every station is a crisp machined
 * edge, while normals stay smooth around each band's rounded corners.
 */
function dieGeometry(): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  const rings = PROFILE.map(ring)
  const n = rings[0]!.length
  const push = (p: readonly [number, number, number], u: number) => {
    pos.push(p[0], p[1], p[2])
    uv.push(u, p[1] / LENGTH)
    return pos.length / 3 - 1
  }
  for (let s = 0; s + 1 < rings.length; s++) {
    const a = rings[s]!
    const b = rings[s + 1]!
    const base = pos.length / 3
    for (let i = 0; i <= n; i++) {
      push(a[i % n]!, i / n)
      push(b[i % n]!, i / n)
    }
    for (let i = 0; i < n; i++) {
      const a0 = base + 2 * i
      const b0 = a0 + 1
      const a1 = a0 + 2
      const b1 = a0 + 3
      index.push(a0, b0, a1, a1, b0, b1)
    }
  }
  // The face: a fan, facing down.
  const face = rings[0]!
  const centre = push([0, 0, 0], 0.5)
  const first = pos.length / 3
  face.forEach((p, i) => push(p, i / n))
  for (let i = 0; i < n; i++) index.push(centre, first + i, first + ((i + 1) % n))
  // The shank's far end, never seen but closed so no rig can look into the tube.
  const top = rings[rings.length - 1]!
  const cap = push([0, LENGTH, 0], 0.5)
  const rim = pos.length / 3
  top.forEach((p, i) => push(p, i / n))
  for (let i = 0; i < n; i++) index.push(cap, rim + ((i + 1) % n), rim + i)

  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return geo
}

export interface PunchParts {
  group: Group
  /** The die's steel, which sees the room at its own strength (engine.ts sets its envMap). */
  steel: MeshStandardMaterial
  setPlacement: (at: { x: number; z: number; scale: number }, portrait: boolean) => void
  apply: (p: Pose) => void
  dispose: () => void
}

export function createPunch(opts: { blob: Texture }): PunchParts {
  const geo = dieGeometry()

  /* Hardened tool steel: a little rougher than the bar, so the two metals never read as one, but
     fully metallic, so the shank carries the long vertical highlight of turned steel. Its upright
     faces mirror the studio's dark lower band, so it sees that room brighter than the bar does
     (STEEL_ROOM in engine.ts) and reads as grey steel rather than a black silhouette. */
  const steel = new MeshStandardMaterial({ color: new Color('#9aa1a8'), metalness: 1, roughness: 0.32 })
  const die = new Mesh(geo, steel)

  /* The die's own shade on the bar, darkening as it closes in: the one cue that says how far the
     face is from the metal before they meet. */
  const blobGeo = new PlaneGeometry(FACE_W * 1.45, FACE_D * 2.6)
  blobGeo.rotateX(-Math.PI / 2)
  const blobMat = new MeshBasicMaterial({
    color: 0x000000,
    alphaMap: opts.blob,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    opacity: 0,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  })
  const blob = new Mesh(blobGeo, blobMat)

  const group = new Group()
  group.add(die, blob)

  return {
    group,
    steel,
    setPlacement(at, portrait) {
      group.position.set(at.x, 0, at.z)
      group.rotation.y = portrait ? Math.PI / 2 : 0
      group.scale.set(at.scale, 1, at.scale)
    },
    apply(p) {
      die.position.y = BAR.height + p.punch
      die.visible = p.punch < PUNCH_PARKED - 1e-3
      blob.position.y = BAR.height + 0.0012
      const near = 1 - Math.min(1, p.punch / 1.1)
      blobMat.opacity = 0.6 * near * near
      blob.visible = blobMat.opacity > 0.002
    },
    dispose() {
      geo.dispose()
      steel.dispose()
      blobGeo.dispose()
      blobMat.dispose()
    },
  }
}
