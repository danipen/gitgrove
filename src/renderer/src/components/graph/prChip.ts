// The PR chip a branch label wears: the canvas twin of the branch switcher's
// `#123` badge (.branch-pr in toolbar.css) — same glyph geometry, same sizes,
// same colors — so a PR reads identically everywhere in the app. Only the
// leading glyph carries meaning: the CI rollup for an open PR (✓ passing,
// ✗ failing, a pulsing amber dot running; nothing when no checks ran), GitHub's
// merged / closed octicon otherwise. Drawn in WORLD space inside the label
// pill, so it zooms with it.
//
// Unlike the badge it wears no pill of its own — a neutral patch on a tinted
// label reads as a foreign sticker, worst at small zoom — just a hairline
// divider and the glyph + number in the label's ink. On a tinted branch pill
// the glyph keeps its state color: the label's opaque near-background base
// lets it contrast for any hue. On the solid accent HEAD pill the state colors
// would sink into the fill, so there the glyph takes the pill's ink too — the
// same thin mark, its shape (✓ / ✗ / pulsing dot / octicon) carrying the state.
//
// The running dot breathes like the badge's (ci-pulse, primitives.css):
// ciPulseAlpha mirrors the keyframes, and the canvas only animates while such
// a dot is on screen (render.ts prChipsPulsing).

import type { PullRequestInfo } from '@shared/types'
import { PR_CHIP_GAP, PR_CHIP_H } from './geometry'

/** The chip's slice of the graph palette (render.ts readPalette): the font
 *  family and the state colors. */
export interface PrChipColors {
  font: string
  success: string
  failure: string
  pending: string
  merged: string
}

/** How the chip sits in its label: its ink (the number), the divider's color,
 *  and whether the glyph wears that ink instead of its state color (the solid
 *  accent HEAD pill — see the file header). */
export interface PrChipStyle {
  ink: string
  divider: string
  inkGlyph: boolean
}

// .branch-pr metrics (toolbar.css): 10.5px/500 text, 4px side padding, 2px gap
// after the glyph; CiStatus draws its check/cross at 10px,
// the octicons at 11px, the running dot at 6px.
const CHIP_FONT = 10.5
const PAD_X = 4
const GLYPH_GAP = 2
const CI_ICON = 10
const OCTICON = 11
const DOT = 6

// Icon.Check / Icon.Close (lib/icons.tsx) on their 24-unit grid, stroked 1.7 —
// the exact marks CiStatus renders.
const CHECK_D = 'm5 12 5 5L20 6'
const CROSS_D = 'M6 6 18 18M18 6 6 18'
const ICON_STROKE = 1.7

// GitHub's merged / closed pull-request octicons on their 16-unit grid — the
// same paths as Icon.PrMerged / Icon.PrClosed. Path2D is built lazily: it
// doesn't exist outside a browser (tests import this module).
const MERGED_D =
  'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z'
const CLOSED_D =
  'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm0 11a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM11.25 9.5a.75.75 0 0 1 .75.75v.378a2.251 2.251 0 1 1-1.5 0V10.25a.75.75 0 0 1 .75-.75Zm0 4a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM9.22 1.227a.75.75 0 0 1 1.06 0l.97.97.97-.97a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l.97-.97-.97-.97a.75.75 0 0 1 0-1.06Z'
let glyphPaths: Record<'success' | 'failure' | 'merged' | 'closed', Path2D> | null = null

type Glyph = 'success' | 'failure' | 'pending' | 'merged' | 'closed' | null

/** The leading glyph for a PR — the badge's rule (PrHoverCard PrGlyph). */
export function prChipGlyph(pr: PullRequestInfo): Glyph {
  if (pr.state === 'open') return pr.checks
  return pr.state
}

/** The badge's ci-pulse period (primitives.css). */
const PULSE_MS = 1300

/** A running dot's opacity at time `ms`: 1 → 0.35 → 1 over PULSE_MS, eased
 *  like CSS ease-in-out keyframes — the canvas twin of `ci-pulse`. */
export function ciPulseAlpha(ms: number): number {
  const phase = (ms % PULSE_MS) / PULSE_MS
  return 1 - 0.65 * ((1 - Math.cos(phase * 2 * Math.PI)) / 2)
}

const chipFont = (family: string) => `500 ${CHIP_FONT}px ${family}`

function glyphWidth(glyph: Exclude<Glyph, null>): number {
  if (glyph === 'pending') return DOT
  return glyph === 'merged' || glyph === 'closed' ? OCTICON : CI_ICON
}

/** The chip's width for `pr`, text measured in the chip font. */
export function measurePrChip(ctx: CanvasRenderingContext2D, family: string, pr: PullRequestInfo) {
  ctx.font = chipFont(family)
  const text = ctx.measureText(`#${pr.number}`).width
  const glyph = prChipGlyph(pr)
  return PAD_X * 2 + text + (glyph ? glyphWidth(glyph) + GLYPH_GAP : 0)
}

/** Paint the chip for `pr` into `rect` (world space, from geometry prChipRect). */
export function drawPrChip(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number },
  pr: PullRequestInfo,
  colors: PrChipColors,
  style: PrChipStyle,
  /** The running dot's current opacity (ciPulseAlpha). */
  pulse: number
): void {
  // The hairline sits in the gap before the chip, a touch shorter than it.
  const divX = Math.round(rect.x - PR_CHIP_GAP / 2) + 0.5
  ctx.beginPath()
  ctx.moveTo(divX, rect.y + 2)
  ctx.lineTo(divX, rect.y + PR_CHIP_H - 2)
  ctx.strokeStyle = style.divider
  ctx.lineWidth = 1
  ctx.stroke()

  const midY = rect.y + PR_CHIP_H / 2
  let x = rect.x + PAD_X
  const glyph = prChipGlyph(pr)
  if (glyph) {
    const size = glyphWidth(glyph)
    const color = style.inkGlyph ? style.ink : stateColor(glyph, colors)
    drawGlyph(ctx, glyph, x, midY - size / 2, size, color, pulse)
    x += size + GLYPH_GAP
  }
  ctx.font = chipFont(colors.font)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = style.ink
  ctx.fillText(`#${pr.number}`, x, midY + 0.5)
}

function stateColor(glyph: Exclude<Glyph, null>, colors: PrChipColors): string {
  if (glyph === 'success') return colors.success
  if (glyph === 'pending') return colors.pending
  if (glyph === 'merged') return colors.merged
  return colors.failure
}

/** A `size`-square glyph with its top-left at (x, y), in `color`. */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: Exclude<Glyph, null>,
  x: number,
  y: number,
  size: number,
  color: string,
  pulse: number
): void {
  ctx.save()
  if (glyph === 'pending') {
    ctx.globalAlpha *= pulse
    ctx.beginPath()
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
    return
  }
  glyphPaths ??= {
    success: new Path2D(CHECK_D),
    failure: new Path2D(CROSS_D),
    merged: new Path2D(MERGED_D),
    closed: new Path2D(CLOSED_D)
  }
  ctx.translate(x, y)
  if (glyph === 'merged' || glyph === 'closed') {
    ctx.scale(size / 16, size / 16)
    ctx.fillStyle = color
    ctx.fill(glyphPaths[glyph])
  } else {
    ctx.scale(size / 24, size / 24)
    ctx.strokeStyle = color
    ctx.lineWidth = ICON_STROKE
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke(glyphPaths[glyph])
  }
  ctx.restore()
}
