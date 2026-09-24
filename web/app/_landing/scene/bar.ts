import {
  BufferAttribute,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type Texture,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { BAR, type Pose } from './pose'
import { POLISH } from './textures'

/**
 * The Stock Token bar: `pieces` identical pieces on one RoundedBoxGeometry and one material, laid
 * end to end. Where two rounded pieces touch, their bevels form the scored V-groove, so the lines the
 * bar later breaks along are there from the first frame. A multiplier that is not a whole number
 * 2..8 gives one piece: a bar that does not divide.
 */

/** Space between pieces while the bar is whole: just enough to keep the grooves from z-fighting. */
const GAP = 0.004
const BEVEL = 0.024
/** Extra room between neighbouring pieces once the bar has divided. */
const SPREAD = 0.34
const LIFT = 0.055
/** Stamps sit this far above the top face; polygonOffset does the rest. */
const SKIN = 0.0008
/** The hallmark's width; it is 4:1, like its texture. The punch face is cut to match (punch.ts). */
export const HALLMARK_W = 0.86

export interface Layout {
  pieces: number
  /** Cells on the engraving strip. Four when they fit the pieces without a seam through a stamp. */
  cells: number
  /** Cell index of each stamp, in the order symbol, multiplier, supply, block (-1 = not shown). */
  slots: readonly [number, number, number, number]
}

export function layoutFor(segments: number | null): Layout {
  const pieces = segments && segments >= 2 && segments <= 8 ? Math.round(segments) : 1
  // 1, 2 and 4 pieces put no seam through a quarter of the strip; 3 and 5..8 need a cell per piece.
  const cells = pieces === 1 || pieces === 2 || pieces === 4 ? 4 : pieces
  const slots: Layout['slots'] =
    cells === 3 ? [0, 1, -1, 2] : [0, Math.round((cells - 1) / 3), Math.round((2 * (cells - 1)) / 3), cells - 1]
  return { pieces, cells, slots }
}

const pieceX = (i: number, n: number) => -BAR.length / 2 + (i + 0.5) * (BAR.length / n)

export interface BarParts {
  group: Group
  /** Where the hallmark sits, in the bar group's frame, for the punch to land on. */
  hallmarkAt: (portrait: boolean) => { x: number; z: number; scale: number }
  hallmark: MeshStandardMaterial
  setPortrait: (portrait: boolean) => void
  apply: (p: Pose) => void
  dispose: () => void
}

export function createBar(opts: {
  layout: Layout
  atlas: Texture
  hallmarkMap: Texture
  shadow: { texture: Texture; margin: number }
}): BarParts {
  const { layout, atlas, hallmarkMap, shadow } = opts
  const n = layout.pieces
  const pieceW = BAR.length / n
  const group = new Group()

  const metal = new MeshPhysicalMaterial({
    color: new Color('#B9BEC4'),
    metalness: 1,
    roughness: POLISH,
    clearcoat: 0.3,
    clearcoatRoughness: 0.14,
  })
  const pieceGeo = new RoundedBoxGeometry(pieceW - GAP, BAR.height, BAR.depth, 4, BEVEL)

  /* The stamps are a skin of the same metal laid over the top face: identical where the atlas is
     blank, so the skin has no visible edge, and cut where it is not. The atlas (see textures.ts)
     drives roughness (the figures frosted), depth as a bump map (every glyph has walls that catch
     the room) and occlusion (a recess sees less of the room). A cut figure reads darker against a
     bright reflection and lighter against a dark one, as a real stamp does when the bar turns. */
  const engraving = new MeshPhysicalMaterial({
    color: metal.color,
    metalness: 1,
    roughness: 1,
    roughnessMap: atlas,
    bumpMap: atlas,
    bumpScale: 1.8,
    aoMap: atlas,
    aoMapIntensity: 0.85,
    clearcoat: metal.clearcoat,
    clearcoatRoughness: metal.clearcoatRoughness,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  /* Gold on this site means byte-verified, so the inlay has to arrive on screen as the page's own
     --streak, not as whatever the tone curve and the metal under it make of it.
     - The texture is the whole plaque in colour (textures.ts): gold strokes on a touchstone bed,
       transparent outside the cartouche. It is the map and the emissive map both, so the strokes
       glow #D6B25E and the bed stays black stone, as the brand's gold face always sits on stone.
       Used as an alpha map instead (the first cut), the gold's green channel became its coverage,
       and the strokes landed at 45% over the bar: olive on dark metal, champagne on bright.
     - It skips tone mapping, so the resting glow (GOLD_FLOOR in engine.ts) is what reaches the
       screen, and the room it reflects (GOLD_ROOM) only adds a sheen that moves as the bar turns. */
  const hallmark = new MeshStandardMaterial({
    color: new Color('#ffffff'),
    map: hallmarkMap,
    metalness: 1,
    roughness: 0.32,
    emissive: new Color('#ffffff'),
    emissiveMap: hallmarkMap,
    emissiveIntensity: 0,
    transparent: true,
    toneMapped: false,
    opacity: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const shadowGeo = new PlaneGeometry(pieceW - GAP + 2 * shadow.margin, BAR.depth + 2 * shadow.margin)
  shadowGeo.rotateX(-Math.PI / 2)

  const pieces: Group[] = []
  const shadows: Mesh[] = []
  const shadowMats: MeshBasicMaterial[] = []
  for (let i = 0; i < n; i++) {
    const g = new Group()
    g.position.x = pieceX(i, n)
    const m = new Mesh(pieceGeo, metal)
    m.position.y = BAR.height / 2
    g.add(m)
    group.add(g)
    pieces.push(g)

    const sm = new MeshBasicMaterial({
      color: 0x000000,
      alphaMap: shadow.texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.9,
    })
    const s = new Mesh(shadowGeo, sm)
    s.position.set(pieceX(i, n), 0.001, 0)
    s.renderOrder = -1
    group.add(s)
    shadows.push(s)
    shadowMats.push(sm)
  }

  /* One plane per engraving cell, its UVs cut to that cell of the atlas, parented to the piece it
     sits on so the stamps travel with the divide. */
  const cellW = BAR.length / layout.cells
  const cellAspect = 2048 / layout.cells / 256
  const cellGeos: PlaneGeometry[] = []
  const cells: Array<{ mesh: Mesh; offset: number }> = []
  for (let c = 0; c < layout.cells; c++) {
    if (!layout.slots.includes(c)) continue
    const geo = new PlaneGeometry(1, 1)
    const uv = geo.getAttribute('uv') as BufferAttribute
    for (let k = 0; k < uv.count; k++) uv.setX(k, (c + uv.getX(k)) / layout.cells)
    uv.needsUpdate = true
    cellGeos.push(geo)
    const cx = -BAR.length / 2 + (c + 0.5) * cellW
    const owner = Math.min(n - 1, Math.floor((cx + BAR.length / 2) / pieceW))
    const mesh = new Mesh(geo, engraving)
    mesh.rotation.order = 'YXZ'
    mesh.rotation.x = -Math.PI / 2
    pieces[owner]!.add(mesh)
    cells.push({ mesh, offset: cx - pieceX(owner, n) })
  }

  /* The hallmark goes under the multiplier's stamp: the bytes it carries are that call's return. */
  const multCell = layout.slots[1]
  const multX = -BAR.length / 2 + (multCell + 0.5) * cellW
  const hOwner = Math.min(n - 1, Math.floor((multX + BAR.length / 2) / pieceW))
  const hOffset = multX - pieceX(hOwner, n)
  const hallGeo = new PlaneGeometry(HALLMARK_W, HALLMARK_W / 4)
  const hallMesh = new Mesh(hallGeo, hallmark)
  hallMesh.rotation.order = 'YXZ'
  hallMesh.rotation.x = -Math.PI / 2
  pieces[hOwner]!.add(hallMesh)

  /* Landscape: stamps along the back half of the top face, the hallmark along the front half, all
     reading along the bar. Portrait: the bar stands up the screen, so each stamp and the hallmark
     turn a quarter to read across it, stamp above hallmark within the piece. */
  function hallmarkAt(portrait: boolean) {
    const scale = portrait
      ? Math.min(1, (pieceW * 0.42) / (HALLMARK_W / 4), 1.1 / HALLMARK_W)
      : Math.min(1, (pieceW - 0.16) / HALLMARK_W)
    const local = portrait ? hOffset + Math.min(cellW, pieceW) * 0.25 : hOffset
    return { x: pieceX(hOwner, n) + local, z: portrait ? 0 : 0.34, scale }
  }

  function setPortrait(portrait: boolean) {
    for (const { mesh, offset } of cells) {
      if (portrait) {
        const h = Math.min(0.44, 1.1 / cellAspect, cellW * 0.44)
        mesh.scale.set(h * cellAspect, h, 1)
        mesh.position.set(offset - cellW * 0.2, BAR.height + SKIN, 0)
      } else {
        const h = Math.min(0.44, (cellW - 0.12) / cellAspect)
        mesh.scale.set(h * cellAspect, h, 1)
        mesh.position.set(offset, BAR.height + SKIN, -0.3)
      }
      mesh.rotation.y = portrait ? Math.PI / 2 : 0
    }
    const at = hallmarkAt(portrait)
    hallMesh.scale.setScalar(at.scale)
    hallMesh.position.set(at.x - pieceX(hOwner, n), BAR.height + SKIN * 1.5, at.z)
    hallMesh.rotation.y = portrait ? Math.PI / 2 : 0
  }
  setPortrait(false)

  const mid = (n - 1) / 2
  // The divided bar never grows longer than four pieces' worth of spread, so any count stays in frame.
  const spread = SPREAD * Math.min(1, 3 / Math.max(1, n - 1))
  function apply(p: Pose) {
    for (let i = 0; i < n; i++) {
      const g = pieces[i]!
      const k = i - mid
      const side = Math.sign(k)
      const reach = mid > 0 ? Math.abs(k) / mid : 0
      const lift = LIFT * p.hop * (0.55 + 0.45 * reach)
      g.position.x = pieceX(i, n) + k * spread * p.split
      g.position.y = lift
      // The outer pieces tip away from the break and settle; the inner ones barely move.
      g.rotation.z = -side * 0.05 * p.hop * (0.4 + 0.6 * reach)
      g.rotation.y = (i % 2 ? 1 : -1) * 0.018 * p.hop
      const s = shadows[i]!
      s.position.x = g.position.x
      shadowMats[i]!.opacity = 0.9 * Math.max(0, 1 - lift * 7)
    }
    hallmark.opacity = p.hallmark
    hallMesh.visible = p.hallmark > 0.001
  }

  return {
    group,
    hallmarkAt,
    hallmark,
    setPortrait,
    apply,
    dispose() {
      pieceGeo.dispose()
      shadowGeo.dispose()
      hallGeo.dispose()
      for (const g of cellGeos) g.dispose()
      metal.dispose()
      engraving.dispose()
      hallmark.dispose()
      for (const m of shadowMats) m.dispose()
    },
  }
}
