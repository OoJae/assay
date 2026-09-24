import { CanvasTexture, NoColorSpace, SRGBColorSpace, type Texture } from 'three'
import { HALLMARK } from '../../_brand/mark'

/**
 * Every texture in the scene, drawn once into a 2D canvas: no image downloads, and the stamps are
 * set in the page's own Martian Mono with the board's real values.
 *
 * Alpha maps are white on black because three reads an alphaMap's green channel, not its alpha.
 * Canvas text cannot be trusted with fontStretch or letterSpacing across browsers, so condensed
 * figures are a horizontal setTransform scale and tracked captions are set a glyph at a time.
 */

export interface Stamp {
  /** Small tracked line above the figure: what the figure is. */
  caption: string
  /** The figure itself. */
  value: string
  /** Largest size the figure may be set at, px on a 256 px tall cell. */
  max?: number
}

const FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/**
 * The page's mono family (next/font's generated name, from --font-mono), loaded before any glyph
 * is drawn. A canvas that draws before the face arrives bakes the fallback into the texture for
 * good, so this waits for it, but no longer than 2 s: after that a system mono is better than no bar.
 */
export async function monoFamily(): Promise<string> {
  let family = ''
  try {
    family = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  } catch {
    /* no computed style: use the fallback */
  }
  if (!family) return FALLBACK
  try {
    await Promise.race([
      Promise.all([document.fonts.load(`500 96px ${family}`), document.fonts.load(`400 24px ${family}`)]),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  } catch {
    /* a failed load still leaves the fallback in the stack */
  }
  return `${family}, ${FALLBACK}`
}

function canvas2d(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('2d canvas unavailable')
  return { c, ctx }
}

function finish(c: HTMLCanvasElement, color: boolean, anisotropy: number): Texture {
  const t = new CanvasTexture(c)
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace
  t.anisotropy = anisotropy
  t.needsUpdate = true
  return t
}

/** Text condensed by `sx`, centred on `cx`, sitting on `baseline`. Returns its drawn width. */
function condensed(ctx: CanvasRenderingContext2D, text: string, cx: number, baseline: number, sx: number) {
  const w = ctx.measureText(text).width * sx
  ctx.save()
  ctx.setTransform(sx, 0, 0, 1, cx - w / 2, baseline)
  ctx.fillText(text, 0, 0)
  ctx.restore()
  return w
}

/** Text tracked out by `track` px per glyph, centred on `cx`: the stamped-caption look. */
function tracked(ctx: CanvasRenderingContext2D, text: string, cx: number, baseline: number, track: number) {
  const glyphs = [...text]
  const widths = glyphs.map((g) => ctx.measureText(g).width)
  const total = widths.reduce((a, b) => a + b, 0) + track * (glyphs.length - 1)
  let x = cx - total / 2
  glyphs.forEach((g, i) => {
    ctx.fillText(g, x, baseline)
    x += widths[i]! + track
  })
}

/**
 * The engraving: one 2048×256 strip that runs the length of the bar's top face, cut into `cells`
 * equal cells, each holding one stamp or nothing. Each cell becomes its own plane (see bar.ts), so
 * the stamps can be turned to read across the bar when the bar stands up the screen in portrait.
 *
 * Not an alpha map: the skin's material reads two channels of it. Green is roughness (three's
 * roughnessMap samples G): POLISH in the field, the polished bar's own value, so the skin is invisible
 * there, and 0.78 in the figures, frosted. Red is depth, read both as the bump map and as the
 * ambient-occlusion map (both sample R): 1 in the field, 0.43 in the figures, so a cut is recessed
 * and also dimmer in the room's reflection, which keeps it legible on the brightest top face.
 */
/**
 * The bar's roughness, about 0.14: polished, so the studio's lights come back as highlights with
 * an edge. A whole number of 255ths, so the skin's field (one byte of the atlas) matches the bar
 * exactly and its outline never shows. bar.ts reads it too.
 */
const POLISH_BYTE = 36
export const POLISH = POLISH_BYTE / 255
const FIELD = `rgb(255, ${POLISH_BYTE}, 0)`
const CUT = 'rgb(110, 199, 0)'

export function engravingAtlas(stamps: ReadonlyArray<Stamp | null>, family: string, anisotropy: number): Texture {
  const W = 2048
  const H = 256
  const { c, ctx } = canvas2d(W, H)
  ctx.fillStyle = FIELD
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = CUT
  ctx.textBaseline = 'alphabetic'
  const cellW = W / Math.max(1, stamps.length)
  stamps.forEach((s, i) => {
    if (!s) return
    const cx = cellW * (i + 0.5)
    const room = cellW - 72
    // The figure: as large as the cell allows, condensed to about Martian's 87.5 width.
    const sx = 0.84
    let size = s.max ?? 120
    ctx.font = `500 ${size}px ${family}`
    const natural = ctx.measureText(s.value).width * sx
    if (natural > room) {
      size = Math.floor((size * room) / natural)
      ctx.font = `500 ${size}px ${family}`
    }
    ctx.globalAlpha = 1
    condensed(ctx, s.value, cx, 206, sx)
    // The caption: small, tracked, a little shallower than the figure (lower alpha reads as a lighter cut).
    ctx.font = `400 23px ${family}`
    ctx.globalAlpha = 0.82
    tracked(ctx, s.caption, cx, 62, 4)
    ctx.globalAlpha = 1
  })
  return finish(c, false, anisotropy)
}

/** The page's --streak and --touchstone: the hallmark is the one place the scene uses either. */
export const STREAK = '#D6B25E'
const TOUCHSTONE = '#0D0D0C'

/**
 * The hallmark, 1024×256, colour and alpha: a cartouche holding the ASSAY punch face and the bytes
 * it vouches for, the raw uiMultiplier() return and the block it was read at.
 *
 * The gold sits on a touchstone bed filling the cartouche, as docs/BRAND.md requires of the gold
 * face on any ground that is not touchstone: its cuts (the A, the score) stay dark, and the gold
 * never lies directly on bright silver, where its thin strokes would blend into the metal and read
 * as champagne instead of --streak.
 */
export function hallmarkTexture(bytes: string | null, block: string | null, family: string, anisotropy: number): Texture {
  const W = 1024
  const H = 256
  const { c, ctx } = canvas2d(W, H)
  ctx.clearRect(0, 0, W, H)

  // The cartouche: the brand plaque's chamfered outline, stretched to the stamp's 4:1.
  const inset = 10
  const ch = 30
  ctx.lineWidth = 9
  ctx.lineJoin = 'miter'
  ctx.beginPath()
  ctx.moveTo(inset + ch, inset)
  ctx.lineTo(W - inset - ch, inset)
  ctx.lineTo(W - inset, inset + ch)
  ctx.lineTo(W - inset, H - inset - ch)
  ctx.lineTo(W - inset - ch, H - inset)
  ctx.lineTo(inset + ch, H - inset)
  ctx.lineTo(inset, H - inset - ch)
  ctx.lineTo(inset, inset + ch)
  ctx.closePath()
  ctx.fillStyle = TOUCHSTONE
  ctx.fill()
  ctx.strokeStyle = STREAK
  ctx.stroke()
  ctx.fillStyle = STREAK

  // The mark, from the brand's own geometry: the plaque spans y 4–60 of its 64 box.
  const s = 2.7
  const markX = 52
  const markY = (H - 56 * s) / 2 - 4 * s
  ctx.save()
  ctx.translate(markX, markY)
  ctx.scale(s, s)
  ctx.fill(new Path2D(HALLMARK.mark))
  ctx.restore()

  const textX = markX + 64 * s + 44
  const room = W - textX - 52
  if (bytes) {
    const sx = 0.8
    let size = 66
    ctx.font = `500 ${size}px ${family}`
    const natural = ctx.measureText(bytes).width * sx
    if (natural > room) {
      size = Math.floor((size * room) / natural)
      ctx.font = `500 ${size}px ${family}`
    }
    const w = ctx.measureText(bytes).width * sx
    ctx.save()
    ctx.setTransform(sx, 0, 0, 1, textX + (room - w) / 2, 124)
    ctx.fillText(bytes, 0, 0)
    ctx.restore()
  }
  if (block) {
    ctx.font = `400 44px ${family}`
    tracked(ctx, `@${block}`, textX + room / 2, 196, 6)
  }
  return finish(c, true, anisotropy)
}

/**
 * A soft contact shadow for a footprint of aspect `w:d`, baked once. The shape is drawn off the
 * canvas and only its shadow is offset onto it: ctx.filter blur is missing in Safari, shadowBlur is not.
 * Two passes, a tight dark core where the metal meets the stone and a wide soft falloff.
 */
export function shadowTexture(w: number, d: number): { texture: Texture; margin: number } {
  const margin = 0.32 // scene units of falloff around the footprint, each side
  const pxPerUnit = 150
  const W = Math.round((w + 2 * margin) * pxPerUnit)
  const H = Math.round((d + 2 * margin) * pxPerUnit)
  const { c, ctx } = canvas2d(W, H)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  const x = margin * pxPerUnit
  const y = margin * pxPerUnit
  const rw = w * pxPerUnit
  const rh = d * pxPerUnit
  const off = W + 100
  const pass = (blur: number, alpha: number, grow: number) => {
    ctx.save()
    ctx.shadowColor = `rgba(255,255,255,${alpha})`
    ctx.shadowBlur = blur
    ctx.shadowOffsetX = off
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.roundRect(x - off - grow, y - grow, rw + 2 * grow, rh + 2 * grow, 10)
    ctx.fill()
    ctx.restore()
  }
  pass(44, 0.55, 6)
  pass(8, 0.9, -2)
  return { texture: finish(c, false, 1), margin }
}

/** Seeded, so the streak and the stone grain are the same on every load and in every poster. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The streak plate's proportions, length over width: the plane in bench.ts is cut to match. */
export const STREAK_ASPECT = 2

/**
 * The touchstone test, as the stone looks after it: three short strokes side by side, the middle
 * one rubbed from the bar and the outer two from the reference needles it is compared against.
 * Each stroke is a haze of fine lines laid along the rub: dense down the middle where the metal was
 * pressed hardest, thinning to nothing at the edges, with ragged ends and the stone's grain showing
 * through wherever the deposit is thin.
 *
 * The first two cuts were one long stroke, soft at both ends and then tapered to a point; from the
 * rigs' low pitch either one foreshortened into a bright sliver that read as a blade lying on the
 * bench. Solid, evenly lit strokes read as rods. Short, soft-edged, granular ones read as metal
 * rubbed into stone, which is the one thing this texture has to say.
 *
 * Sterling, not gold: gold on this site means a verified value, and nothing is verified yet on the
 * bench. White on black, read as an alpha map.
 */
export function streakTexture(anisotropy: number): Texture {
  const W = 1024
  const H = Math.round(W / STREAK_ASPECT)
  const { c, ctx } = canvas2d(W, H)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  const r = rng(8056)
  ctx.lineCap = 'round'
  // [centre, half-width, start, end] per stroke, as fractions of the plate. The bar's own stroke is
  // the middle, widest and longest; the needles' strokes are shorter and do not line up with it.
  const strokes: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.2, 0.1, 0.16, 0.7],
    [0.5, 0.13, 0.06, 0.9],
    [0.8, 0.1, 0.22, 0.8],
  ]
  for (const [v, hw, s0, s1] of strokes) {
    const cy = v * H
    const half = hw * H
    const x0 = s0 * W
    const x1 = s1 * W
    const len = x1 - x0
    for (let i = 0; i < 520; i++) {
      // Lines bunch toward the middle of the band (u² falls off), so its edges are a thinning haze.
      const u = (r() + r() + r()) / 1.5 - 1
      const y = cy + u * half
      const start = x0 + len * (0.05 * u * u + 0.06 * r())
      const end = x1 - len * (0.22 * r() ** 2 + 0.08 * u * u)
      const a = (0.18 + 0.4 * r()) * (1 - 0.7 * u * u)
      const g = ctx.createLinearGradient(start, 0, end, 0)
      g.addColorStop(0, 'rgba(255,255,255,0)')
      g.addColorStop(0.04, `rgba(255,255,255,${a})`)
      g.addColorStop(0.6, `rgba(255,255,255,${a * 0.75})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.strokeStyle = g
      ctx.lineWidth = 0.7 + r() * 1.4
      ctx.beginPath()
      ctx.moveTo(start, y)
      ctx.lineTo(end, y + (r() - 0.5) * 1.5)
      ctx.stroke()
    }
    // The stone's grain showing through: short dark flecks, more of them where the rub thinned out.
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 1100; i++) {
      const t = r() ** 0.8
      const x = x0 + len * t
      const y = cy + (r() * 2 - 1) * half * 1.1
      ctx.fillStyle = `rgba(0,0,0,${0.25 + 0.6 * r() * (0.4 + t)})`
      ctx.fillRect(x, y, 2 + r() * 8 * (0.3 + t), 0.8 + r() * 1.4)
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  return finish(c, false, anisotropy)
}

/**
 * The bench: a pool of black stone that fades to nothing, so its edge is the page itself. Colour
 * and alpha in one map; a faint grain keeps the lit centre from reading as a flat gradient.
 */
export function benchTexture(anisotropy: number): Texture {
  const S = 512
  const { c, ctx } = canvas2d(S, S)
  const img = ctx.createImageData(S, S)
  const r = rng(4663)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5
      const dy = (y + 0.5) / S - 0.5
      const d = Math.sqrt(dx * dx + dy * dy) / 0.5
      // Smooth falloff from the centre to the rim: alpha 0 by d = 1, so the plane's edge is invisible.
      const a = d >= 1 ? 0 : (1 - d * d) ** 2
      const grain = (r() - 0.5) * 5
      const i = (y * S + x) * 4
      img.data[i] = 17 + grain
      img.data[i + 1] = 17 + grain
      img.data[i + 2] = 16 + grain
      img.data[i + 3] = Math.round(a * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
  return finish(c, true, anisotropy)
}
