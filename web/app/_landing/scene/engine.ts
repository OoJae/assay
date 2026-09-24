import {
  ACESFilmicToneMapping,
  Color,
  Group,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
  type Texture,
} from 'three'
import type { LandingBar } from '@/lib/landing'
import { P_STRIKE, type ProgressStore } from '../progress'
import { HALLMARK_W, createBar, layoutFor, type Layout } from './bar'
import { createBench } from './bench'
import { createEnvironment } from './env'
import { createPerfGuard } from './perf-guard'
import { POSTER_PROGRESS, pose } from './pose'
import { createPunch } from './punch'
import { FOV, barTurn, landscapeWeight, placeCamera } from './rigs'
import {
  benchTexture,
  engravingAtlas,
  hallmarkTexture,
  monoFamily,
  shadowTexture,
  streakTexture,
  type Stamp,
} from './textures'

/**
 * The scene, imperatively. No React inside the canvas: the scene is a fixed set of meshes posed
 * from one number each frame, and plain three lets the bundler keep only the classes used. The
 * @react-three/fiber <Canvas> registers the whole THREE namespace, and that alone measured 249 KB
 * gzipped against the 3D chunk's 250 KB budget.
 *
 * The loop renders on demand: a scroll wakes it through store.onChange, it damps the shown progress
 * toward the scroll position, and it stops requesting frames once they agree. A still page costs no
 * GPU time at all.
 */

export type SceneFailure = 'webgl' | 'context-lost' | 'perf' | 'error'

export interface EngineOptions {
  host: HTMLElement
  bar: LandingBar | null
  store: ProgressStore
  /** 1..5 renders that step's poster pose once and never animates; null runs the live scene. */
  poster: number | null
  onReady: () => void
  onFail: (reason: SceneFailure) => void
}

const CLEAR = '#0D0D0C'
/** Damping rate toward the scroll position, per second (a half-life of about 87 ms). */
const DAMPING = 8
/** How long the freshly struck gold stays bright. */
const GLINT_MS = 650
/**
 * The gold inlay's own glow, as a share of --streak. The inlay is not tone mapped (bar.ts), so this
 * is close to what reaches the screen: the struck mark reads as the page's gold on bright metal and
 * dark alike, wherever the bar turns.
 */
const GOLD_FLOOR = 0.96
/** How much of the room the gold inlay reflects, against 1 for the bar: a sheen, not a mirror. */
const GOLD_ROOM = 0.16
/** And the punch: its upright faces mirror the dark lower half of the studio, so it sees it brighter. */
const STEEL_ROOM = 2.4
/**
 * The environment's resting turn, chosen by rendering the hero at eight turns: at this one the near
 * end of the bar (by the captions) catches the brightest softbox and the far end falls into shade.
 */
const ENV_BASE = 1

/** '4.000000000' → '×4', '1.500000000' → '×1.5': the cited value, without the zeros. */
function multiplierFigure(value: string): string {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
  return `×${trimmed}`
}

/** The raw return with its 48-odd leading zero digits elided: 0x…3782dace9d900000. */
function significantBytes(raw: string): string {
  const hex = raw.replace(/^0x/i, '').replace(/^0+/, '') || '0'
  return hex.length <= 20 ? `0x…${hex}` : `0x${hex.slice(0, 6)}…${hex.slice(-10)}`
}

function stampsFor(bar: LandingBar | null, layout: Layout): Array<Stamp | null> {
  const cells: Array<Stamp | null> = Array.from({ length: layout.cells }, () => null)
  if (!bar) return cells
  const stamps: Stamp[] = [
    { caption: 'STOCK TOKEN', value: bar.symbol },
    { caption: 'uiMultiplier()', value: multiplierFigure(bar.multiplier.value), max: 176 },
    { caption: 'totalSupply()', value: bar.supply.tokens },
    { caption: 'BLOCK', value: bar.block },
  ]
  layout.slots.forEach((slot, k) => {
    if (slot >= 0) cells[slot] = stamps[k]!
  })
  return cells
}

const clamp01 = (t: number) => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0)

export function startEngine(o: EngineOptions): () => void {
  let alive = true
  let failed = false
  const fail = (reason: SceneFailure) => {
    if (!alive || failed) return
    failed = true
    o.onFail(reason)
  }

  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'

  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
      // Posters are read back by a screenshot; the live canvas never needs its old frame.
      preserveDrawingBuffer: o.poster !== null,
    })
  } catch {
    // three needs WebGL2; without it there is nothing to draw with.
    queueMicrotask(() => fail('webgl'))
    return () => {
      alive = false
    }
  }
  o.host.appendChild(canvas)
  renderer.setClearColor(new Color(CLEAR), 1)
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.outputColorSpace = SRGBColorSpace

  const scene = new Scene()
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 60)
  /** The bar and the punch: this group turns -90° in portrait. The bench does not turn. */
  const root = new Group()
  scene.add(root)

  const onLost = (e: Event) => {
    e.preventDefault()
    fail('context-lost')
  }
  canvas.addEventListener('webglcontextlost', onLost)

  type Built = {
    bar: ReturnType<typeof createBar>
    punch: ReturnType<typeof createPunch>
    bench: ReturnType<typeof createBench>
    env: ReturnType<typeof createEnvironment>
    textures: Texture[]
  }
  let built: Built | null = null
  let maxDpr = o.poster !== null ? 2 : 1.5
  let aspect = 1
  let portrait: boolean | null = null
  let raf = 0
  let idle = true
  let last = 0
  let current = 0
  let strikeAt = -Infinity

  const guard = createPerfGuard(
    () => {
      maxDpr = 1
      resize()
    },
    () => fail('perf'),
  )

  function orient(p: boolean) {
    if (!built) return
    portrait = p
    built.bar.setPortrait(p)
    built.punch.setPlacement(built.bar.hallmarkAt(p), p)
    built.bench.setPortrait(p)
  }

  function resize() {
    const w = Math.max(1, o.host.clientWidth)
    const h = Math.max(1, o.host.clientHeight)
    // Posters render at 2× whatever the screen, and the capture downsamples: free supersampling.
    renderer.setPixelRatio(o.poster !== null ? 2 : Math.min(window.devicePixelRatio || 1, maxDpr))
    renderer.setSize(w, h, false)
    aspect = w / h
    const p = landscapeWeight(aspect) < 0.5
    if (p !== portrait) orient(p)
    invalidate()
  }

  function apply(progress: number, now: number) {
    if (!built) return
    const P = pose(progress)
    root.rotation.y = barTurn(landscapeWeight(aspect))
    built.bar.apply(P)
    built.punch.apply(P)
    built.env.setTurn(ENV_BASE + P.env)
    // The inlay and the die carry their own reference to the map (for their own intensity), so they turn with the room by hand.
    built.bar.hallmark.envMapRotation.copy(scene.environmentRotation)
    built.punch.steel.envMapRotation.copy(scene.environmentRotation)
    const since = now - strikeAt
    built.bar.hallmark.emissiveIntensity = GOLD_FLOOR + (since < GLINT_MS ? 0.3 * (1 - since / GLINT_MS) ** 2 : 0)
    placeCamera(camera, P.cam, P.drift, aspect)
  }

  function frame(now: number) {
    raf = 0
    if (!alive || failed || !built) return
    // The first frame after a rest has no meaningful interval: step as if at 60 Hz and don't sample it.
    const dt = idle ? 1 / 60 : Math.min(Math.max(now - last, 0) / 1000, 1 / 30)
    if (!idle) guard.sample(now - last)
    last = now

    let moving = false
    if (o.poster === null) {
      const target = clamp01(o.store.target)
      const prev = current
      current += (target - current) * (1 - Math.exp(-DAMPING * dt))
      if (Math.abs(target - current) < 1e-4) current = target
      else moving = true
      o.store.current = current
      // The strike fires from the progress the viewer sees, so the recoil lands with the punch.
      if (prev < P_STRIKE && current >= P_STRIKE && now - strikeAt > 800) {
        strikeAt = now
        o.store.onStrike?.()
      }
    }
    apply(current, now)
    renderer.render(scene, camera)
    idle = !(moving || now - strikeAt < GLINT_MS)
    if (!idle) invalidate()
  }

  function invalidate() {
    if (!raf && alive && !failed && built) raf = requestAnimationFrame(frame)
  }

  const ro = new ResizeObserver(() => resize())
  ro.observe(o.host)

  /* Building the scene used to be one synchronous task of several hundred milliseconds (textures,
     meshes, the PMREM room), long enough to delay input on a phone. Handing control back between
     the stages keeps each piece short; the canvas is not shown until compileAsync resolves anyway. */
  const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0))

  void (async () => {
    const family = await monoFamily()
    if (!alive) return
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    const layout = layoutFor(o.bar?.segments ?? null)
    const pieceW = 4 / layout.pieces
    /* Posters carry no figures. A poster is a still of the metal, shown whatever board the landing
       was built from; if the block and bytes were engraved into it, it would state numbers that stop
       being true one sweep later. The captions beside it carry every value. */
    const marked = o.poster === null ? o.bar : null
    const atlas = engravingAtlas(stampsFor(marked, layout), family, aniso)
    const hall = hallmarkTexture(
      marked ? significantBytes(marked.multiplier.raw) : null,
      marked ? marked.block : null,
      family,
      aniso,
    )
    await yieldToMain()
    if (!alive) return
    const shadow = shadowTexture(pieceW, 1.3)
    const blob = shadowTexture(HALLMARK_W + 0.035, HALLMARK_W / 4 + 0.035)
    const stone = benchTexture(aniso)
    const streak = streakTexture(aniso)
    await yieldToMain()
    if (!alive) return

    const bar = createBar({ layout, atlas, hallmarkMap: hall, shadow })
    const punch = createPunch({ blob: blob.texture })
    const bench = createBench({ stone, streak })
    await yieldToMain()
    if (!alive) return
    const env = createEnvironment(renderer, scene)
    /* Gold means byte-verified on this site, so the inlay must read as --streak on bright metal and
       dark alike: it sees the room at reduced strength and makes up the rest in its own colour. */
    bar.hallmark.envMap = env.map
    bar.hallmark.envMapIntensity = GOLD_ROOM
    punch.steel.envMap = env.map
    punch.steel.envMapIntensity = STEEL_ROOM
    root.add(bar.group, punch.group)
    scene.add(...bench.meshes)
    built = { bar, punch, bench, env, textures: [atlas, hall, shadow.texture, blob.texture, stone, streak] }

    portrait = null
    resize()
    current = o.poster !== null ? POSTER_PROGRESS[Math.min(4, Math.max(0, o.poster - 1))]! : clamp01(o.store.target)
    o.store.current = current
    apply(current, performance.now())

    // Compile every program off the main thread where the driver allows, before anything is shown.
    await renderer.compileAsync(scene, camera)
    if (!alive || failed) return
    renderer.render(scene, camera)
    if (o.poster === null) o.store.onChange = invalidate
    // Ready once that frame is on screen, so a fade-in never starts on an empty canvas.
    requestAnimationFrame(() => {
      if (alive && !failed) o.onReady()
    })
  })().catch(() => fail('error'))

  if (process.env.NODE_ENV !== 'production') {
    // Development only: lets the dev-scene bench and QA scripts read draw calls and triangles.
    ;(window as unknown as { __assayScene?: unknown }).__assayScene = {
      renderer,
      scene,
      camera,
      info: () => ({ ...renderer.info.render, dpr: renderer.getPixelRatio() }),
    }
  }

  return () => {
    alive = false
    if (raf) cancelAnimationFrame(raf)
    ro.disconnect()
    canvas.removeEventListener('webglcontextlost', onLost)
    if (o.store.onChange === invalidate) o.store.onChange = undefined
    if (built) {
      built.bar.dispose()
      built.punch.dispose()
      built.bench.dispose()
      built.env.dispose()
      for (const t of built.textures) t.dispose()
      built = null
    }
    renderer.dispose()
    // Hand the context back now rather than when the GC finds it: browsers cap live contexts.
    renderer.forceContextLoss()
    canvas.remove()
    if (process.env.NODE_ENV !== 'production') {
      delete (window as unknown as { __assayScene?: unknown }).__assayScene
    }
  }
}
