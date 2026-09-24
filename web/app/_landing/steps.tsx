import type { ReactNode } from 'react'
import type { LandingBar, LandingFacts } from '@/lib/landing'
import { HALLMARK } from '../_brand/mark'
import s from './stage.module.css'

/**
 * The five steps of the assay, as a server-rendered list: a poster and a caption each.
 *
 * Numbered because they are the verifier's own sequence: read the supply, read the multiplier,
 * cite both by their bytes, derive the share count, re-fetch every citation before publishing. All
 * text and numbers are here in the DOM, so the list reads the same with no JS, to a screen reader,
 * and under reduced motion; the stage only fades these in and out. A poster is a picture of the
 * scene with no figures on it (see POSTER_SEGMENTS), never the only place a value appears.
 *
 * Colour follows the site's rule: raw bytes, and a decoded value printed beside them, are streak.
 * The share count is derived, so it is cupel, with its two verified operands in streak.
 */

const NAMES = ['Weigh', 'Read the multiplier', 'Strike', 'Divide', 'Re-fetch'] as const
const WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'] as const

/** The last eight hex digits of a 32-byte return, which is where these values live. */
export function tail(raw: string): string {
  return `0x…${raw.slice(-8)}`
}

/**
 * The split the poster frames were rendered with. Posters are struck with no figures (engine.ts
 * renders poster mode with blank stamps and a hallmark that carries only the mark), so one set
 * stays true for every board; they were first engraved with one block's values and could only be
 * shown beside that block, which the live board leaves within minutes. The one thing a poster
 * still depicts is how many pieces the bar divides into, so any other split gets the line plate.
 */
const POSTER_SEGMENTS = 4

function postersShow(b: LandingBar | null): boolean {
  return !!b && b.segments === POSTER_SEGMENTS
}

export function Steps({ facts }: { facts: LandingFacts }) {
  const b = facts.bar
  const segments = b?.segments ?? null
  const captions = b ? withBar(b, facts) : withoutBar(facts)
  const posters = postersShow(b)

  return (
    <>
      <h2 id="assay-h" className={s.srOnly}>
        How ASSAY checks one number, in five steps
      </h2>
      <ol className={s.steps} aria-labelledby="assay-h">
        {captions.map((c, i) => (
          <li key={i} className={s.step}>
            <div className={s.poster} data-poster="">
              <Plate step={i + 1} segments={segments} />
              {posters ? <Poster n={i + 1} /> : null}
            </div>
            <div className={s.cap} data-cap="">
              <p className={`label ${s.capNum}`}>
                <span className={s.capIdx}>{String(i + 1).padStart(2, '0')}</span> {NAMES[i]}
              </p>
              <h3 className={`display ${s.capTitle}`}>{c.title}</h3>
              <p className={s.capData}>{c.data}</p>
              <p className={s.capBody}>{c.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}

type Caption = { title: ReactNode; data: ReactNode; body: ReactNode }

function Call({ children }: { children: ReactNode }) {
  return <span className={s.call}>{children}</span>
}

function Bytes({ raw }: { raw: string }) {
  return (
    <span className={`streak ${s.bytes}`} title={raw}>
      {tail(raw)}
    </span>
  )
}

function refetch(f: LandingFacts): Caption['data'] {
  return (
    <>
      <span className="streak">
        {f.citations.ok} of {f.citations.total}
      </span>{' '}
      citations re-fetched from chain state and byte-compared before publication · swept at block{' '}
      {f.blockNumber}
    </>
  )
}

function withheld(f: LandingFacts): ReactNode {
  if (f.withheld === 0) {
    return 'The verifier withheld nothing on this sweep. When it does, the wall lists each finding it held back, with the reason.'
  }
  const one = f.withheld === 1
  return (
    <>
      The verifier withheld {f.withheld} {one ? 'finding' : 'findings'} on this sweep
      {f.mismatched > 0 ? `, ${f.mismatched} of them because a read came back different` : ''}. The wall lists{' '}
      {one ? 'it' : 'each one'} with the reason.
    </>
  )
}

function withBar(b: LandingBar, f: LandingFacts): Caption[] {
  const whole = b.segments !== null
  return [
    {
      title: 'The supply, counted in tokens.',
      data: (
        <>
          <Call>totalSupply()</Call> · <span className="streak">{b.supply.tokens}</span> tokens ·{' '}
          <Bytes raw={b.supply.raw} />
        </>
      ),
      body: (
        <>
          Read from {b.symbol} at block {b.block}. Every balance on this token is counted the same way: in
          tokens, not shares.
        </>
      ),
    },
    {
      title: 'The multiplier, from the same block.',
      data: (
        <>
          <Call>uiMultiplier()</Call> · <span className="streak">{b.multiplier.value}</span> ·{' '}
          <Bytes raw={b.multiplier.raw} />
        </>
      ),
      body: (
        <>
          Under ERC-8056 a corporate action changes this number and leaves every balance where it was.
          Skip it, and every share count read from {b.symbol} is off by a factor of {b.multiplier.value}.
        </>
      ),
    },
    {
      title: 'Stamped with its own bytes.',
      data: (
        <>
          <Bytes raw={b.multiplier.raw} /> <span className={s.at}>@</span>{' '}
          <span className="streak">{b.block}</span>
        </>
      ),
      body: (
        <>
          Each value is published with the raw bytes it was decoded from and the block it was read at, so
          anyone can repeat the call and compare. A finding that arrives without them is withheld.
        </>
      ),
    },
    {
      title: whole ? `Each token counts as ${WORDS[b.segments!]} shares.` : 'The bar stays whole.',
      data: (
        <>
          <span className="streak">{b.supply.tokens}</span> × <span className="streak">{b.multiplier.value}</span> ={' '}
          <span className={s.derived}>{b.shares}</span> <span className={s.nowrap}>share-equivalents</span>
        </>
      ),
      body: whole ? (
        <>
          A screen that shows the balance as a share count shows {b.supply.tokens} where there are {b.shares}.
          That gap is what ASSAY looks for.
        </>
      ) : (
        <>
          The multiplier is not a whole number, so there is no clean split to show. The arithmetic is the
          same: {b.supply.tokens} tokens count as {b.shares} shares.
        </>
      ),
    },
    {
      title: 'Checked again before it is published.',
      data: refetch(f),
      body: withheld(f),
    },
  ]
}

/** No share-count finding could be drawn truthfully from this board: the steps, without numbers. */
function withoutBar(f: LandingFacts): Caption[] {
  return [
    {
      title: 'The supply, counted in tokens.',
      data: <Call>totalSupply()</Call>,
      body: 'A Stock Token counts its supply and every balance in tokens, not shares, and a corporate action never moves them.',
    },
    {
      title: 'The multiplier, from the same block.',
      data: <Call>uiMultiplier()</Call>,
      body: 'Under ERC-8056 the corporate action lives here. A reader that skips it reads the wrong share count.',
    },
    {
      title: 'Stamped with its own bytes.',
      data: 'raw return · block',
      body: 'Each value is published with the raw bytes it was decoded from and the block it was read at. A finding that arrives without them is withheld.',
    },
    {
      title: 'Tokens times the multiplier.',
      data: (
        <>
          balance × <Call>uiMultiplier()</Call> / 1e18
        </>
      ),
      body: 'That is the share count. This board has no share-count finding to work through today; the wall has every finding it does have.',
    },
    { title: 'Checked again before it is published.', data: refetch(f), body: withheld(f) },
  ]
}

/**
 * One step's poster, landscape or portrait by the viewport's orientation (the scene's two camera
 * rigs), WebP only: the dark frames compress to 13-33 KB, so an AVIF set would save little and a
 * missing one breaks the image instead of falling back. Rendered by the scene in poster mode, with no figures; every value
 * is in the caption beside it, so it is decorative (alt=""). Only step 01's is fetched
 * eagerly: it is under the hero on first paint.
 */
function Poster({ n }: { n: number }) {
  const base = `/landing/v1/s${n}`
  return (
    <picture className={s.picture}>
      <source media="(orientation: portrait)" type="image/webp" srcSet={`${base}-port.webp`} width={1170} height={2532} />
      <img
        src={`${base}-land.webp`}
        alt=""
        width={1920}
        height={1080}
        decoding="async"
        loading={n === 1 ? 'eager' : 'lazy'}
        fetchPriority={n === 1 ? 'high' : 'low'}
      />
    </picture>
  )
}

/* ---- The line plate: a textless drawing of each step, under the poster ----
   It is what shows before the canvas has faded in, wherever a poster is missing or fails to load,
   and for a bar that does not divide into POSTER_SEGMENTS pieces, so it states nothing: no digits, only the
   bar, its scores, the punch and the hallmark. One drawing per orientation, matching the scene's
   two camera rigs: landscape lays the bar along the screen with its depth running up and to the
   right; portrait stands its length up the screen, seen from above, as the portrait rig does. */

type Pt = readonly [number, number]

/**
 * A parallel projection of the bar's own axes onto the drawing: u runs along the bar (0..1 is its
 * length), v across it (0..1 is its width) and h up from the bench (0..1 is its height). Parallel,
 * so every piece is the same shape wherever it sits and a face can be culled by its winding alone.
 */
interface View {
  box: readonly [number, number]
  o: Pt
  u: Pt
  v: Pt
  h: Pt
  /** How far apart the pieces spread once divided, as a fraction of the bar's length. */
  gap: number
  /** The hallmark's size in drawing units, and which bar axis its width runs along. */
  mark: number
  markAlong: 'u' | 'v'
  shadow: { rx: number; ry: number }
}

const LAND: View = {
  box: [800, 460],
  o: [110, 320],
  u: [560, 0],
  v: [88, -66],
  h: [0, -64],
  gap: 0.046,
  mark: 64,
  markAlong: 'u',
  shadow: { rx: 370, ry: 26 },
}

/** The far end (the scene's CRWD piece) at the top of the screen, the length running down to the viewer. */
const PORT: View = {
  box: [400, 480],
  o: [160, 72],
  u: [-64, 372],
  v: [156, 12],
  h: [8, -26],
  gap: 0.07,
  mark: 58,
  markAlong: 'v',
  shadow: { rx: 150, ry: 230 },
}

const at = (w: View, u: number, v: number, h: number): Pt => [
  w.o[0] + u * w.u[0] + v * w.v[0] + h * w.h[0],
  w.o[1] + u * w.u[1] + v * w.v[1] + h * w.h[1],
]
const pts = (...p: Pt[]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')

/** Twice the signed area of a projected face: its winding, which says which way it faces. */
function winding(p: Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]!
    const [x1, y1] = p[(i + 1) % p.length]!
    a += x0 * y1 - x1 * y0
  }
  return a
}

/** The box's faces, each wound anticlockwise seen from outside, with the class it is drawn in. */
function faces(w: View, u0: number, u1: number) {
  const P = (u: number, v: number, h: number) => at(w, u, v, h)
  return {
    top: [P(u0, 0, 1), P(u1, 0, 1), P(u1, 1, 1), P(u0, 1, 1)],
    sides: [
      { key: 'u0', cls: s.plateSide, p: [P(u0, 0, 0), P(u0, 0, 1), P(u0, 1, 1), P(u0, 1, 0)] },
      { key: 'u1', cls: s.plateSide, p: [P(u1, 0, 0), P(u1, 1, 0), P(u1, 1, 1), P(u1, 0, 1)] },
      { key: 'v0', cls: s.plateFront, p: [P(u0, 0, 0), P(u1, 0, 0), P(u1, 0, 1), P(u0, 0, 1)] },
      { key: 'v1', cls: s.plateFront, p: [P(u0, 1, 0), P(u0, 1, 1), P(u1, 1, 1), P(u1, 1, 0)] },
    ],
  }
}

/** One piece of the bar, from u0 to u1 along it: the faces turned towards the viewer, and the top. */
function Block({ w, u0, u1 }: { w: View; u0: number; u1: number }) {
  const f = faces(w, u0, u1)
  const up = Math.sign(winding(f.top))
  return (
    <g>
      {f.sides
        .filter((side) => Math.sign(winding(side.p)) === up)
        .map((side) => (
          <polygon key={side.key} className={side.cls} points={pts(...side.p)} />
        ))}
      <polygon className={s.plateTop} points={pts(...f.top)} />
    </g>
  )
}

/** The scored lines where the bar will divide: across the top, and down the long face in view. */
function Scores({ w, n }: { w: View; n: number }) {
  const f = faces(w, 0, 1)
  const up = Math.sign(winding(f.top))
  const v = f.sides.find((side) => side.key === 'v0' && Math.sign(winding(side.p)) === up) ? 0 : 1
  const lines = []
  for (let k = 1; k < n; k++) {
    const u = k / n
    lines.push(<polyline key={k} className={s.plateScore} points={pts(at(w, u, v, 0), at(w, u, v, 1), at(w, u, 1 - v, 1))} />)
  }
  return <>{lines}</>
}

/**
 * The hallmark lying on the top face, in streak: the struck hallmark is one of the two things on
 * this site that colour may mark. The 64-unit mark is mapped onto the face's plane, its width
 * along the axis the scene's engraving reads along and its foot towards the viewer.
 */
function Hallmark({ w, u, v }: { w: View; u: number; v: number }) {
  const unit = (d: Pt): Pt => {
    const l = Math.hypot(d[0], d[1])
    return [d[0] / l, d[1] / l]
  }
  // Drawing units per unit of the real bar (4.0 long, 1.3 wide), so the square mark is
  // foreshortened as much as the face it lies on.
  const perU = Math.hypot(w.u[0], w.u[1]) / 4
  const perV = Math.hypot(w.v[0], w.v[1]) / 1.3
  const k = w.mark / 64
  const along = w.markAlong === 'u'
  const across = along ? unit(w.u) : unit(w.v)
  // The mark's foot points down the screen, towards the viewer, whichever way the other axis runs.
  const other = along ? w.v : w.u
  const toward = unit(other[1] > 0 ? other : [-other[0], -other[1]])
  const squash = along ? perV / perU : perU / perV
  const ex: Pt = [across[0] * k, across[1] * k]
  const ey: Pt = [toward[0] * k * squash, toward[1] * k * squash]
  const [cx, cy] = at(w, u, v, 1)
  const e = cx - ex[0] * 32 - ey[0] * 32
  const f = cy - ex[1] * 32 - ey[1] * 32
  const m = [ex[0], ex[1], ey[0], ey[1], e, f].map((x) => x.toFixed(3)).join(' ')
  return (
    <g transform={`matrix(${m})`}>
      <path className={s.plateMark} d={HALLMARK.mark} />
    </g>
  )
}

/** The punch above the hallmark, just short of contact: its shaft runs up out of the drawing. */
function Punch({ w, u, v }: { w: View; u: number; v: number }) {
  const [cx, cy] = at(w, u, v, 1)
  const r = w === LAND ? 26 : 22
  const tip = cy - (w === LAND ? 30 : 16)
  if (w === LAND) {
    return (
      <g className={s.platePunch}>
        <rect x={cx - r} y={tip - 150} width={r * 2} height={150} />
        <ellipse cx={cx} cy={tip} rx={r} ry={9} />
        <rect x={cx - r - 8} y={tip - 196} width={(r + 8) * 2} height={46} rx={6} />
      </g>
    )
  }
  return (
    <g className={s.platePunch}>
      <rect x={cx - r} y={0} width={r * 2} height={tip} />
      <ellipse cx={cx} cy={tip} rx={r} ry={8} />
    </g>
  )
}

function Drawing({ w, step, segments, className }: { w: View; step: number; segments: number | null; className: string }) {
  const n = segments ?? 1
  const divided = step >= 4 && n > 1
  // Pieces spread from the middle when divided, so the bar stays where it was.
  const shift = (k: number) => (divided ? (k - (n - 1) / 2) * w.gap : 0)
  // The hallmark is struck on the second piece, the multiplier's, as the scene strikes it.
  const markPiece = n > 1 ? 1 : 0
  const markU = (markPiece + 0.5) / n + shift(markPiece)
  const [cx, cy] = at(w, 0.5, 0.5, 0)
  // Step 05 pulls back, as the scene's camera does.
  const scale = step === 5 ? 0.82 : 1
  const id = `plate-shadow-${w === LAND ? 'l' : 'p'}${step}`
  const pieces = divided
    ? Array.from({ length: n }, (_, k) => [k / n + shift(k), (k + 1) / n + shift(k)] as const)
    : [[0, 1] as const]
  // Farthest first, so a nearer piece is drawn over the one behind it: in portrait the pieces
  // come down the screen towards the viewer in order; in landscape they never overlap.
  const order = w.u[1] < 0 ? [...pieces].reverse() : pieces

  return (
    <svg
      className={`${s.plate} ${className}`}
      viewBox={`0 0 ${w.box[0]} ${w.box[1]}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={id} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#000" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      {w === LAND ? <line className={s.plateBench} x1="24" y1={w.o[1] + 22} x2="776" y2={w.o[1] + 22} /> : null}
      <g transform={`translate(${(cx * (1 - scale)).toFixed(1)} ${(cy * (1 - scale)).toFixed(1)}) scale(${scale})`}>
        <ellipse cx={cx} cy={cy + 2} rx={w.shadow.rx} ry={w.shadow.ry} fill={`url(#${id})`} />
        {order.map(([u0, u1]) => (
          <Block key={u0} w={w} u0={u0} u1={u1} />
        ))}
        {!divided && step >= 2 && n > 1 ? <Scores w={w} n={n} /> : null}
        {step >= 3 ? <Hallmark w={w} u={markU} v={0.5} /> : null}
        {step === 3 ? <Punch w={w} u={markU} v={0.5} /> : null}
      </g>
      {step === 5 ? (
        <line className={s.plateScan} x1={w.box[0] * 0.05} y1={w.box[1] * 0.38} x2={w.box[0] * 0.95} y2={w.box[1] * 0.38} />
      ) : null}
    </svg>
  )
}

function Plate({ step, segments }: { step: number; segments: number | null }) {
  return (
    <>
      <Drawing w={LAND} step={step} segments={segments} className={s.plateLand!} />
      <Drawing w={PORT} step={step} segments={segments} className={s.platePort!} />
    </>
  )
}
