import { Bodoni_Moda, Instrument_Sans, Martian_Mono } from 'next/font/google'

/**
 * The three faces, self-hosted by next/font (no request to Google at runtime), latin only.
 *
 * Bodoni Moda is loaded italic only because display lines are only ever set italic; its opsz axis
 * lets `font-optical-sizing: auto` reach the 96 cut at hero sizes. Martian Mono keeps its width
 * axis: wide (112.5%) for stamps and labels, condensed (87.5%, 75% for hex) for data.
 *
 * The latin subset has no arrows or check marks (← → ✓); those fall through to the system face.
 */
export const display = Bodoni_Moda({
  subsets: ['latin'],
  style: ['italic'],
  axes: ['opsz'],
  variable: '--font-display',
  display: 'swap',
})

/* Only the display face is preloaded: the hero's thesis line is the largest paint on every page
   that has one. Preloading all three put ~119 KB of fonts at high priority ahead of it and pushed
   mobile LCP past 2.5 s; the body and mono faces swap in a moment later without moving layout
   (next/font's fallback metrics). */
export const sans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  preload: false,
})

export const mono = Martian_Mono({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-mono',
  display: 'swap',
  preload: false,
})

export const fontVariables = `${display.variable} ${sans.variable} ${mono.variable}`
