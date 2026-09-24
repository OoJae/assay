# ASSAY brand

ASSAY checks the numbers a Stock Token reports and publishes only what it re-fetched from chain
state and compared byte for byte. The brand is drawn from the assay office. The touchstone is black
stone that gold leaves a streak on. The cupel is the bone-ash cup of fire assay. The hallmark punch
strikes a mark into metal that has passed.

The geometry lives in `web/app/_brand/mark.tsx`, which is the source of truth. The files in
`web/public/brand/` use the same paths.

## The idea

**The mark is the punch face: a canted shield with one A and one score cut into it. Strike it and
the A stands in the field.**

Assaying ends in a hallmark, and verification is the only thing ASSAY claims, so the logo is the tool
that makes the claim. On the landing, step 03 of the assay scene strikes this exact drawing into the
bar. The score is where the bar divides in step 04, which turns 14.1875 tokens into 56.75
share-equivalents. The logo and the moment of verification are one object.

How it was chosen: three concepts were drawn (struck-punch cartouche, bullion-bar stamp,
touchstone-streak monogram), and two judges scored them. They split: one picked the streak monogram,
the other picked the punch cartouche. The punch won for four reasons:

- Both judges' fixes led to the same silhouette. The streak judge's cure for its worst fault (a bare
  A beside ASSAY reads "A ASSAY") was to borrow the punch's cartouche.
- On touchstone, the only ground this site has, that cartouche would have been a 14% hairline, so the
  fix failed exactly where it was needed.
- The punch matches the plan's written brief (a notched cartouche with a scored line) and ties
  directly to steps 03 and 04.
- Its wordmark has character; the streak's read as stock Eurostile Extended.

Three things came from the streak concept:

- its meaning, as a colour rule: the gold hallmark only ever sits on black stone;
- its pixel discipline: one drawing on a 4-unit grid, so 16 px is exact;
- its restraint with gold: the site header and footer carry the mark in one colour, so the first gold
  hallmark a visitor sees on the landing is the one the punch strikes.

## Colour

Near-monochrome stone and bone, with one accent that means something. Tokens are in
`web/app/globals.css`. Contrast is the WCAG ratio.

| Token | Hex | Role | On touchstone | On cupel |
|---|---|---|---|---|
| `--touchstone` | `#0D0D0C` | Background. The black stone. | — | 16.21:1 |
| `--cupel` | `#EEEAE2` | Primary ink. Bone-ash white. The one-colour mark on dark grounds. | 16.21:1 | — |
| `--ash` | `#8C877E` | Secondary ink, labels, meta. Not for text on cupel. | 5.45:1 | 2.98:1 |
| `--streak` | `#D6B25E` | Byte-verified values and the hallmark. Nothing else (see the gold rule). | 9.62:1 | 1.68:1: never |
| `--aqua-fortis` (`--aqua`) | `#E2573F` | Refusal, mismatch, stale: the acid test failing. Rare. | 5.25:1 | 3.09:1 |
| `--sterling` | `#B9BEC4` | 3D metal base tint; movement (button press ring, the route "scribe"). Never in a logo. | 10.39:1 | 1.56:1 |
| `--hair` | cupel at 14% | Hairlines and dividers. Decorative only. | 1.39:1 | — |
| `--slab`, `--slab-2` | `#141412`, `#1A1917` | Panels. Ash on slab is 5.17:1. | — | — |

Robinhood's greens (`#00C805`, Robin Neon `#CCFF00`) never appear, and neither does anything near them.
The old teal (`#4ec9a5`) is retired.

## The gold rule

If something is streak-coloured, it was re-fetched from chain state and byte-compared. That covers
four things:

- raw return bytes;
- a decoded value shown next to its bytes;
- an N-of-N re-fetched count;
- the hallmark.

A derived value, such as 56.7500 share-equivalents, is cupel, with its operands in streak. Motion is
sterling, never gold.

For the mark, that means:

- **One colour on the site.** The header and footer use the one-colour mark (cupel on touchstone).
  A gold chip on every page would say "verified" about navigation.
- **The gold hallmark only where the hallmark is the subject:** the favicon and app icons, the X
  avatar, the strike in step 03 of the assay scene, and the header of an `/f/[id]` certificate.
- **Gold never sits directly on cupel or white** (1.68:1 and 2.02:1). On a light ground, the gold
  hallmark sits on a touchstone field (the app icons), or over its touchstone plaque so the cuts stay
  dark (the favicon: 9.62:1 where it matters).

## Type

All three faces are variable fonts, self-hosted through `next/font/google` (`web/app/fonts.ts`).

| Role | Face | Setting | Use |
|---|---|---|---|
| Display | Bodoni Moda | Italic, lowercase, optical size 96. Never caps, never bold. | One thesis line per section. |
| Body | Instrument Sans | wdth 100 | Reading text and UI. |
| Utility | Martian Mono | wdth 112.5 in wide caps for labels and stamps; wdth 87.5 for data; 75 for long hex | Labels, hex, block numbers, tables. |

The signature pairing sets ceremony and bytes on one line: a Bodoni italic sentence with a Martian
Mono figure inline in streak. For example: *a token is not a share —* `×4.000000000`.

Fluid scale (the `--step-*` tokens):

| Token | Size | Line height / tracking |
|---|---|---|
| `--step-hero` | `clamp(3rem, 9vw, 10.5rem)` | 0.92 / −0.025em |
| `--step-section` | `clamp(2.25rem, 5vw, 5rem)` | 0.98 |
| `--step-h3` | `clamp(1.35rem, 1.8vw, 1.75rem)` | — |
| `--step-body` | `clamp(1rem, 1.05vw, 1.15rem)` | 1.6 |
| `--step-label` | `0.72rem`, mono wdth 112.5, caps | +0.12em |
| `--step-data` | `0.9rem`, mono wdth 87.5 | — |

The wordmark is a drawing, not a font. Never retype ASSAY in a typeface to stand in for the logo. In
running text, write ASSAY in capitals in the surrounding face.

## The mark

Construction, on a 64-unit box:

- **Plaque:** 64 × 56 at y 4–60, with 8-unit chamfers. It is wider than it is tall, and flat on top
  and bottom.
- **A:** cap y 12–52, legs 8 units wide at a 0.4 slope, feet at x 12 and x 52, flat apex 28–36.
- **Score:** y 32–36, running the full width of the plaque and no further.
- **Grid:** every horizontal and vertical edge is a multiple of 4 units. At 16 px, 4 units = 1 px,
  so the chamfer is 2 px, the legs 2 px and the score 1 px. The mark is exactly crisp at 16, 32, 48
  and 64 px, and one drawing serves every size.

Colourways (there are no others):

| Colourway | Ground | Where |
|---|---|---|
| One colour, cupel | touchstone | Site header and footer, dark slides, embossing |
| One colour, touchstone | cupel or white | Print, light documents |
| Gold face with touchstone cuts | touchstone, or any ground with its plaque underneath | Favicon, app icons, X avatar, certificate header, the step-03 strike |
| Unstruck (plaque and score, no A) | touchstone, in ash | The 404 page only ("Unmarked": nothing was hallmarked) |

## The wordmark

Wide geometric capitals: a flat-apex A, an S with a straight diagonal spine and angle-cut terminals,
and a Y whose arms meet at 55% of the cap. Strokes are 16.7% of the cap height. Spacing is set by eye
at 11 px and 72 px (bounding-box gaps in cap units: A|S 12, S|S 15, S|A 12, and A|Y −4, with the
A's foot tucked under the Y's arm). The wordmark alone is `viewBox 0 0 500.9 100`, so its width is
5.009 × its height.

## The lockup

The lockup is one drawing, `viewBox 0 0 221.05 56`:

- The plaque is at full height (56). The wordmark cap is half of it (28), so the plaque is 2.0× the
  cap.
- The gap is 16.8 units (0.6 of the cap).
- The wordmark's A crossbar is centred on the mark's score (y 30), so both As share one line.

Never rebuild it from a mark and a word with a flex gap, because the alignment only holds at these
offsets. There is one lockup, horizontal. Never set a bare A beside the wordmark.

## Clear space and minimum size

Clear space is **x = half the plaque's height** on every side. For the lockup, x is its wordmark cap
height (14 px for a 28 px lockup). For the mark alone, x is 14 px at 32 px.

| Asset | Minimum | Crisp sizes |
|---|---|---|
| Mark | 16 px (the favicon; the drawing is hinted for it); 5 mm in print | 16, 32, 48, 64 px |
| Lockup | 24 px tall (wordmark cap 12 px); 7 mm in print | 28, 42, 56 px |
| Wordmark alone | 10 px cap height | any |

Below 24 px tall, use the mark or the wordmark on its own.

## Files

| File | What it is |
|---|---|
| `web/public/brand/assay-mark.svg` | The mark, one colour (`currentColor`, touchstone by default) |
| `web/public/brand/assay-mark-streak.svg` | The gold hallmark over its touchstone plaque |
| `web/public/brand/assay-wordmark.svg` | The wordmark, one colour (`currentColor`, touchstone by default) |
| `web/public/brand/assay-lockup.svg` | The lockup in cupel, for touchstone grounds (transparent background) |
| `web/public/brand/assay-lockup-light.svg` | The lockup in touchstone, for cupel grounds |
| `web/public/brand/assay-mark-512.png` | 512 px app icon: the gold hallmark on a touchstone field |
| `web/public/brand/assay-avatar-400.png` | X avatar; the plaque stays inside X's circular crop |
| `web/public/brand/assay-banner-1500x500.png` | X banner; the lower-left corner is left clear for the avatar |
| `web/app/icon.svg` | Favicon: gold face over a touchstone plaque |
| `web/app/apple-icon.png` | 180 px touch icon (plaque 112 px, so 4 units = 7 px) |

In code, use the components: `AssayMark({ size, title, className })`,
`AssayWordmark({ height, title, className })` and `AssayLockup({ height, title, className })`. They draw
in `currentColor`, so CSS sets the ink. `title=""` marks one as decorative (`aria-hidden`).
`HALLMARK` exports the raw 64-box paths (`mark`, `plaque`, `unstruck`) for canvas textures.

## Motion

- **One signature.** The CombiBar assay on the landing is the only loud motion on the site:
  weigh, read the multiplier, strike, divide, re-fetch. Everything else stays quiet.
- **Transform and opacity only,** at 60 fps.
  - Display lines reveal once: lines rise from a mask with expo.out over about 1 s, staggered
    0.08 s.
  - A button press is a 0.97 scale with a sterling ring.
  - A route change scribes the header's sterling hairline across, then fades the page up.
- **The strike is the one physical beat.** The punch drops, the frame recoils about 6 px, and a
  cupel pulse (18% opacity at most, about 120 ms) marks contact as the hallmark appears. The logo
  itself never spins, morphs or shimmers.
- **Verified numbers never count up.** A tween through 47/94 shows a value that was never true.
- **`prefers-reduced-motion`:** no smooth scroll and no sticky scene. Poster frames and fades stand
  in for movement, and the hallmark fades in without the recoil.

## Writing

- Write from the reader's side of the screen: plain verbs, sentence case, specific over clever.
- Every structural label (numbering, eyebrows, dividers) must encode something true. The assay steps
  are numbered because they are the verifier's actual sequence.
- Say "Stock Tokens". Never "tokenized stocks" or "tokenized equities".
- Never label a verified value with a call that was not made. The CRWD finding cites
  `totalSupply()` and `uiMultiplier()`, not `balanceOf()`.

## Robinhood Chain and the disclaimer

- Never use Robinhood or Robinhood Chain marks: not in the logo, not in the 3D scene, not in a
  co-branded lockup.
- Never use Robinhood's greens (`#00C805`, `#CCFF00`) or anything that reads as them.
- ASSAY is always more prominent than "Robinhood Chain", in size, weight and position, on every page,
  card, image and post (Robinhood Chain terms §5.7(b)(iii)).
- The non-affiliation disclaimer appears on every page, in the body face at reading size, never as
  fine print (§5.7(b)(ii)). Put it, or a link to it, wherever Robinhood Chain is named, including
  the X bio. The text lives in `web/lib/site.ts` (`DISCLAIMER`):

> ASSAY is an independent project. It is not affiliated with, endorsed by, or officially connected
> with Robinhood Markets, Inc. or its affiliates, or with Chainlink Labs. "Robinhood Chain" and
> "Chainlink" are used only to identify the network and the data source. Everything ASSAY publishes
> or sells is an automated, informational reading of public blockchain state, provided as is and
> without warranty of any kind. It is not investment, financial, legal or tax advice, it is not a
> security audit, and a finding is not a statement that any party acted wrongly. Verify
> independently before acting.

## Don'ts

- **Don't extend the score past the plaque.** Free of its shield, the line strikes out the A and
  becomes ₳, the Cardano and austral sign.
- **Don't show the A without its plaque.** A bare geometric A is every other fintech monogram.
- **Don't render the plaque in blue or navy,** round it into a hexagon, or turn it point-up. That
  moves it toward Arbitrum's A-in-a-hexagon, and Robinhood Chain runs on Arbitrum Orbit.
- **Don't make a full-bleed gold card or avatar.** It suggests the Robinhood Gold card. The gold
  plaque always sits on touchstone.
- **Don't put gold directly on cupel or white,** and don't use gold for navigation, buttons, focus
  rings or motion.
- **Don't tilt, italicise, outline, bevel, shadow or gradient the mark,** or recolour it outside the
  four colourways.
- **Don't put anything but the A inside the plaque.** The struck hallmark carries its bytes and
  block beside the plaque, not in it.
- **Don't rebuild the lockup from parts,** re-space the wordmark, or set ASSAY in a font as the logo.
- **Don't lock ASSAY up with any Robinhood or Robinhood Chain mark,** and don't set "Robinhood Chain"
  larger or bolder than ASSAY.
- **Don't use the cupel one-colour mark on a light ground** or the touchstone one on a dark ground.
