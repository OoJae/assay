import {
  Color,
  DataTexture,
  DataUtils,
  DirectionalLight,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  PMREMGenerator,
  RGBAFormat,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three'

/**
 * Light for polished metal. A bar at metalness 1 is lit almost entirely by what it reflects, so the
 * environment is the lighting.
 *
 * ARCHITECTURE named three's RoomEnvironment. Rendered, its grey walls gave the sterling a flat,
 * plastic look: polished metal reads as metal only when it reflects contrast, a dark room with a few
 * large soft lights, as in a product studio. A first studio built from boxes, the way
 * RoomEnvironment builds its room, fixed that but left dark gaps between its lights, and coplanar
 * pieces of the same bar came back one white and the next black.
 *
 * So the studio is painted instead: a half-float equirectangular image, computed here from a short
 * list of lights, prefiltered once through PMREM on the GPU, then thrown away. Nothing is
 * downloaded, every light has a smooth shoulder rather than an edge, and values run well past 1 so
 * the reflections keep a real highlight through ACES instead of clipping to grey.
 *
 * One warm-neutral key light adds the direct term for the bench and the punch; there are no shadow
 * maps (contact shadows are baked, see textures.ts).
 */
export interface EnvParts {
  /** The prefiltered map, for a material that needs its own intensity (scene.environment ignores it). */
  map: Texture
  setTurn: (y: number) => void
  dispose: () => void
}

/**
 * One soft light, placed by compass: `az` degrees from the bar's front (+z) toward +x, `el` degrees
 * above the horizon. `w` × `h` is its angular size in degrees and `v` its radiance at the core.
 * `soft` is the share of each half-size given to the shoulder.
 */
interface Light {
  az: number
  el: number
  w: number
  h: number
  v: number
  tint?: string
  soft?: number
}

/*
 * What each part of the bar sees, given the rigs in rigs.ts:
 * - The top faces mirror the room behind the bar at the camera's own pitch: 18–31° in the low
 *   landscape rigs, 40–68° in the close-up, the pull-back and portrait. The band of light there is
 *   continuous, brighter on the key side, so neighbouring pieces read as one polished surface and a
 *   turn of the room slides the highlight along the bar instead of switching faces on and off.
 * - The sides mirror the room below the horizon in front of the bar. A dim warm floor bounce there
 *   gives them a slow gradient, dark metal rather than a hole.
 * - The bevels sweep through 90° of normals, so any narrow strip lands on them as a thin bright line:
 *   the edge light that says "machined".
 */
const LIGHTS: readonly Light[] = [
  // The key: a large softbox behind and left, at the low rigs' pitch.
  { az: 200, el: 24, w: 70, h: 26, v: 3.2, tint: '#fff4e6', soft: 0.7 },
  // Its counterpart behind and right, dimmer and cooler, so the band never drops to black.
  { az: 140, el: 28, w: 60, h: 24, v: 1.25, tint: '#eef2f7', soft: 0.75 },
  // The rest of the band, all the way round, low: the top faces never see a gap.
  { az: 290, el: 22, w: 90, h: 22, v: 0.55, soft: 0.8 },
  { az: 40, el: 22, w: 90, h: 22, v: 0.4, soft: 0.8 },
  // The high ring, for the steep rigs.
  { az: 175, el: 58, w: 80, h: 26, v: 1.9, tint: '#f6f3ee', soft: 0.75 },
  { az: 300, el: 60, w: 60, h: 22, v: 1.0, soft: 0.8 },
  { az: 60, el: 60, w: 60, h: 22, v: 0.8, soft: 0.8 },
  // A narrow strip nearly overhead: the one crisp line across a top face.
  { az: 20, el: 82, w: 110, h: 3.5, v: 7, soft: 0.5 },
  // Edge strips, tall and thin, low on either side: the bevel lines.
  { az: 262, el: 18, w: 4, h: 50, v: 9, tint: '#fff1e0', soft: 0.45 },
  { az: 95, el: 14, w: 3, h: 40, v: 5, tint: '#eef3fa', soft: 0.45 },
  // Floor bounce in front, for the sides: warm, dim, wide.
  { az: 350, el: -26, w: 120, h: 30, v: 0.22, tint: '#e9e2d6', soft: 0.9 },
  { az: 150, el: -22, w: 100, h: 26, v: 0.1, soft: 0.9 },
]

/** The room itself, by elevation: near black, the floor a shade lighter than the ceiling. */
function ambient(el: number): number {
  const s = Math.sin(el)
  return s >= 0 ? 0.014 - 0.008 * s : 0.02 + 0.012 * -s
}

const D = Math.PI / 180
const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

/**
 * The studio as a half-float equirectangular image, in three's own mapping (equirectUv): column u
 * is atan2(z, x), row v is asin(y), row 0 at the bottom.
 */
function studioTexture(W = 1024, H = 512): DataTexture {
  const n = W * H
  const dx = new Float32Array(n)
  const dy = new Float32Array(n)
  const dz = new Float32Array(n)
  const rgb = new Float32Array(n * 3)
  for (let j = 0; j < H; j++) {
    const el = ((j + 0.5) / H - 0.5) * Math.PI
    const a0 = ambient(el)
    const ce = Math.cos(el)
    const se = Math.sin(el)
    for (let i = 0; i < W; i++) {
      const a = ((i + 0.5) / W - 0.5) * 2 * Math.PI
      const k = j * W + i
      dx[k] = ce * Math.cos(a)
      dy[k] = se
      dz[k] = ce * Math.sin(a)
      rgb[3 * k] = a0
      rgb[3 * k + 1] = a0
      rgb[3 * k + 2] = a0 * 0.96
    }
  }

  const tint = new Color()
  for (const L of LIGHTS) {
    tint.set(L.tint ?? '#ffffff')
    const soft = L.soft ?? 0.6
    // The light's frame: c at its centre, r to its right, u up along it.
    const az = L.az * D
    const el = L.el * D
    const cx = Math.cos(el) * Math.sin(az)
    const cy = Math.sin(el)
    const cz = Math.cos(el) * Math.cos(az)
    let rx = cz
    let rz = -cx
    const rl = Math.hypot(rx, rz) || 1
    rx /= rl
    rz /= rl
    const ux = cy * rz
    const uy = cz * rx - cx * rz
    const uz = -cy * rx
    const hw = (L.w / 2) * D
    const hh = (L.h / 2) * D
    const reach = Math.cos(Math.min(Math.PI * 0.95, Math.hypot(hw, hh) * 1.05))
    // Rows the light can touch, so a small light costs a small loop.
    const span = Math.hypot(hw, hh) * 1.05
    const j0 = Math.max(0, Math.floor(((el - span) / Math.PI + 0.5) * H))
    const j1 = Math.min(H - 1, Math.ceil(((el + span) / Math.PI + 0.5) * H))
    for (let j = j0; j <= j1; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i
        const x = dx[k]!
        const y = dy[k]!
        const z = dz[k]!
        const d = x * cx + y * cy + z * cz
        if (d < reach) continue
        // Angular offsets inside the light's frame.
        const ax = Math.atan2(x * rx + z * rz, d)
        const ay = Math.atan2(x * ux + y * uy + z * uz, d)
        const ex = Math.abs(ax) / hw
        const ey = Math.abs(ay) / hh
        if (ex >= 1 || ey >= 1) continue
        const f = smoothstep((1 - ex) / soft) * smoothstep((1 - ey) / soft)
        // A little brighter at the top of each light than the bottom, as a real softbox hangs.
        const v = L.v * f * (0.85 + 0.15 * (ay / hh))
        rgb[3 * k] += v * tint.r
        rgb[3 * k + 1] += v * tint.g
        rgb[3 * k + 2] += v * tint.b
      }
    }
  }

  const data = new Uint16Array(n * 4)
  const one = DataUtils.toHalfFloat(1)
  for (let k = 0; k < n; k++) {
    data[4 * k] = DataUtils.toHalfFloat(rgb[3 * k]!)
    data[4 * k + 1] = DataUtils.toHalfFloat(rgb[3 * k + 1]!)
    data[4 * k + 2] = DataUtils.toHalfFloat(rgb[3 * k + 2]!)
    data[4 * k + 3] = one
  }
  const t = new DataTexture(data, W, H, RGBAFormat, HalfFloatType)
  t.mapping = EquirectangularReflectionMapping
  t.colorSpace = LinearSRGBColorSpace
  t.magFilter = LinearFilter
  t.minFilter = LinearFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

export function createEnvironment(renderer: WebGLRenderer, scene: Scene): EnvParts {
  const pmrem = new PMREMGenerator(renderer)
  const source = studioTexture()
  const map = pmrem.fromEquirectangular(source).texture
  source.dispose()
  pmrem.dispose()

  scene.environment = map
  scene.environmentIntensity = 1

  const key = new DirectionalLight(new Color('#fff2e0'), 1.4)
  key.position.set(-3, 6, 4)
  scene.add(key)
  scene.add(key.target)

  return {
    map,
    setTurn(y) {
      scene.environmentRotation.set(0, y, 0)
    },
    dispose() {
      scene.environment = null
      scene.remove(key, key.target)
      key.dispose()
      map.dispose()
    },
  }
}
