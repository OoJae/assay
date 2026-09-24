/**
 * The ASSAY hallmark: the face of a steel punch. A canted shield with one A and one score cut into
 * it; strike it into metal and the A stands in a sunken field, split where the bar divides.
 *
 * Every shape is an outlined path in currentColor, so the surrounding CSS picks the ink and nothing
 * waits on a font. The mark sits on a 64-unit box in which every horizontal and vertical edge is a
 * multiple of 4 units. At 16, 32, 48 and 64 px, and in a 28 px lockup, the plaque, the score and the
 * A's feet therefore land on whole pixels; at other sizes they blur. docs/BRAND.md holds the rules,
 * and public/brand/ holds the files.
 *
 * Gold is not a prop. The site shows this mark in one colour; it goes gold (color: var(--streak),
 * on touchstone only) where the hallmark itself is the subject: the struck certificate, the strike
 * in the assay scene, and the app icons.
 */
type MarkProps = { size?: number; title?: string; className?: string }
type LockupProps = { height?: number; title?: string; className?: string }

/* The punch face on the 64 box: the plaque (64×56 at y 4–60, 8-unit chamfers) minus the A (cap
   y 12–52, legs 8 wide) and the score (y 32–36). The three pieces never overlap, so either fill
   rule gives the same result. */
const MARK =
  'M64 12L56 4H8L0 12V32H20L28 12H36L44 32H64Z' +
  'M0 52L8 60H56L64 52V36H45.6L52 52H44L37.6 36H26.4L20 52H12L18.4 36H0Z' +
  'M28 32H36L32 22Z'
const PLAQUE = 'M64 12L56 4H8L0 12V52L8 60H56L64 52Z'
const UNSTRUCK = 'M64 12L56 4H8L0 12V32H64ZM0 52L8 60H56L64 52V36H0Z'

/* Wordmark, cap height 100 = the viewBox height. The A's crossbar centreline is at y 58.3. */
const WORDMARK_W = 500.9
const WORDMARK =
  'M80.45 61.12L56 0H40L0 100H18L31.32 66.69H64.68L78 100H96ZM48 25L57.99 49.98H38.01Z' +
  'M188.29 12.06A27.36 27.36 0 0 0 165.61 0L134.83 0A26.86 26.86 0 0 0 129.08 53.09L170.89 62.25A10.64 10.64 0 0 1 168.61 83.29L135.83 83.29A11.14 11.14 0 0 1 126.59 78.38L112.73 87.72A27.86 27.86 0 0 0 135.83 100L168.61 100A27.36 27.36 0 0 0 174.47 45.92L132.66 36.77A10.14 10.14 0 0 1 134.83 16.71L165.61 16.71A10.64 10.64 0 0 1 174.44 21.4Z' +
  'M291.24 12.06A27.36 27.36 0 0 0 268.56 0L237.78 0A26.86 26.86 0 0 0 232.03 53.09L273.84 62.25A10.64 10.64 0 0 1 271.56 83.29L238.78 83.29A11.14 11.14 0 0 1 229.54 78.38L215.68 87.72A27.86 27.86 0 0 0 238.78 100L271.56 100A27.36 27.36 0 0 0 277.42 45.92L235.61 36.77A10.14 10.14 0 0 1 237.78 16.71L268.56 16.71A10.64 10.64 0 0 1 277.39 21.4Z' +
  'M391.35 61.12L366.9 0H350.9L310.9 100H328.9L342.22 66.69H375.58L388.9 100H406.9ZM358.9 25L368.89 49.98H348.91Z' +
  'M402.9 0L443.54 55V100H460.26V55L500.9 0H480.12L451.9 38.19L423.68 0Z'

/* Lockup: the plaque at full height (56), the wordmark at half of it (cap 28), 16.8 apart (0.6 cap).
   The wordmark's A crossbar is centred on the score (y 30), so the two As share one line. */
const LOCKUP_W = 221.05
const LOCKUP_MARK =
  'M64 8L56 0H8L0 8V28H20L28 8H36L44 28H64Z' +
  'M0 48L8 56H56L64 48V32H45.6L52 48H44L37.6 32H26.4L20 48H12L18.4 32H0Z' +
  'M28 28H36L32 18Z'
const LOCKUP_WORDMARK =
  'M103.33 30.78L96.48 13.67H92L80.8 41.67H85.84L89.57 32.34H98.91L102.64 41.67H107.68ZM94.24 20.67L97.04 27.66H91.44Z' +
  'M133.52 17.05A7.66 7.66 0 0 0 127.17 13.67L118.55 13.67A7.52 7.52 0 0 0 116.94 28.54L128.65 31.1A2.98 2.98 0 0 1 128.01 36.99L118.83 36.99A3.12 3.12 0 0 1 116.25 35.62L112.36 38.23A7.8 7.8 0 0 0 118.83 41.67L128.01 41.67A7.66 7.66 0 0 0 129.65 26.53L117.94 23.97A2.84 2.84 0 0 1 118.55 18.35L127.17 18.35A2.98 2.98 0 0 1 129.64 19.66Z' +
  'M162.35 17.05A7.66 7.66 0 0 0 156 13.67L147.38 13.67A7.52 7.52 0 0 0 145.77 28.54L157.48 31.1A2.98 2.98 0 0 1 156.84 36.99L147.66 36.99A3.12 3.12 0 0 1 145.07 35.62L141.19 38.23A7.8 7.8 0 0 0 147.66 41.67L156.84 41.67A7.66 7.66 0 0 0 158.48 26.53L146.77 23.97A2.84 2.84 0 0 1 147.38 18.35L156 18.35A2.98 2.98 0 0 1 158.47 19.66Z' +
  'M190.38 30.78L183.53 13.67H179.05L167.85 41.67H172.89L176.62 32.34H185.96L189.69 41.67H194.73ZM181.29 20.67L184.09 27.66H178.49Z' +
  'M193.61 13.67L204.99 29.07V41.67H209.67V29.07L221.05 13.67H215.23L207.33 24.36L199.43 13.67Z'

/**
 * Raw geometry, on the 64 box, for code that cannot render React SVG: the step-03 hallmark
 * CanvasTexture (`new Path2D(HALLMARK.mark)`, scaled by size / 64) and the 404's unstruck cartouche
 * (the plaque and its score, no A). `plaque` is the silhouette to lay underneath in touchstone
 * wherever the gold face sits on a ground that is not touchstone, so the cuts stay dark.
 */
export const HALLMARK = { viewBox: '0 0 64 64', mark: MARK, plaque: PLAQUE, unstruck: UNSTRUCK } as const

/* title="" means the mark sits beside text that already says ASSAY: hide it from assistive tech. */
function a11y(title: string) {
  return title ? ({ role: 'img', 'aria-label': title } as const) : ({ 'aria-hidden': true } as const)
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function AssayMark({ size = 32, title = 'ASSAY', className }: MarkProps) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} {...a11y(title)}>
      <path className="mark" fill="currentColor" d={MARK} />
    </svg>
  )
}

export function AssayWordmark({ height = 16, title = 'ASSAY', className }: LockupProps) {
  return (
    <svg
      viewBox={`0 0 ${WORDMARK_W} 100`}
      width={r2((height * WORDMARK_W) / 100)}
      height={height}
      className={className}
      {...a11y(title)}
    >
      <path className="wordmark" fill="currentColor" fillRule="evenodd" d={WORDMARK} />
    </svg>
  )
}

/** One drawing, not a flex pair: the crossbar-on-score alignment only holds at these exact offsets. */
export function AssayLockup({ height = 28, title = 'ASSAY', className }: LockupProps) {
  return (
    <svg
      viewBox={`0 0 ${LOCKUP_W} 56`}
      width={r2((height * LOCKUP_W) / 56)}
      height={height}
      className={className}
      {...a11y(title)}
    >
      <path className="mark" fill="currentColor" d={LOCKUP_MARK} />
      <path className="wordmark" fill="currentColor" fillRule="evenodd" d={LOCKUP_WORDMARK} />
    </svg>
  )
}
