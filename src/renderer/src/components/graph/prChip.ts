// The PR chip a branch label wears: the canvas twin of the branch switcher's
// `#123` badge (.branch-pr in toolbar.css) — same glyph geometry, same sizes,
// same colors — so a PR reads identically everywhere in the app. Only the
// leading glyph carries meaning: the CI rollup for an open PR (✓ passing,
// ✗ failing, a pulsing amber dot running), GitHub's draft octicon for a draft
// with no checks yet, nothing for a ready PR with no checks, and GitHub's
// merged / closed octicon once it settles. Drawn in WORLD space inside the
// label pill, so it zooms with it.
//
// It wears no pill of its own — a neutral patch on a tinted label reads as a
// foreign sticker, worst at small zoom — just a hairline divider and the glyph
// + number in the label's ink. On a tinted branch pill the glyph sits bare: the
// label's opaque near-background base lets the state colors contrast for any
// hue — the current branch's included: it is tinted in the accent like any
// other label (its identity is the solid home cap it leads with, render.ts
// drawHomeCap), so no state color ever lands on a saturated fill. The glyph
// is exactly the same on every branch, red and green intact.
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
  draft: string
}

/** How the chip sits in its label: its ink (the number) and the divider's
 *  color — both in the label's own hue. */
export interface PrChipStyle {
  ink: string
  divider: string
}

// .branch-pr metrics (toolbar.css): 10.5px/500 text, 4px side padding, 2px gap
// after the glyph; CiStatus draws its check/cross at 10px, the octicons at
// 11px, the running dot at 6px.
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

// GitHub's merged / closed / draft pull-request octicons on their 16-unit grid
// — the same paths as Icon.PrMerged / Icon.PrClosed / Icon.PrDraft. Path2D is
// built lazily: it doesn't exist outside a browser (tests import this module).
const MERGED_D =
  'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z'
const CLOSED_D =
  'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm0 11a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM11.25 9.5a.75.75 0 0 1 .75.75v.378a2.251 2.251 0 1 1-1.5 0V10.25a.75.75 0 0 1 .75-.75Zm0 4a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM9.22 1.227a.75.75 0 0 1 1.06 0l.97.97.97-.97a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l.97-.97-.97-.97a.75.75 0 0 1 0-1.06Z'
const DRAFT_D =
  'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z'
type Octicon = 'merged' | 'closed' | 'draft'
let glyphPaths: Record<'success' | 'failure' | Octicon, Path2D> | null = null

type Glyph = 'success' | 'failure' | 'pending' | Octicon
const isOcticon = (glyph: Glyph): glyph is Octicon =>
  glyph === 'merged' || glyph === 'closed' || glyph === 'draft'

/** The leading glyph for a PR — the badge's rule (PrHoverCard PrGlyph): CI
 *  first, then a draft's octicon, then (settled PRs) the state octicon. */
export function prChipGlyph(pr: PullRequestInfo): Glyph | null {
  if (pr.state !== 'open') return pr.state
  return pr.checks ?? (pr.draft ? 'draft' : null)
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

function glyphSize(glyph: Glyph): number {
  if (glyph === 'pending') return DOT
  return isOcticon(glyph) ? OCTICON : CI_ICON
}

/** The glyph's slot width plus the gap after it; 0 without a glyph. */
function glyphAdvance(glyph: Glyph | null): number {
  return glyph ? glyphSize(glyph) + GLYPH_GAP : 0
}

/** The chip's width for `pr`, text measured in the chip font. */
export function measurePrChip(ctx: CanvasRenderingContext2D, family: string, pr: PullRequestInfo) {
  ctx.font = chipFont(family)
  const text = ctx.measureText(`#${pr.number}`).width
  return PAD_X * 2 + glyphAdvance(prChipGlyph(pr)) + text
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
  const glyph = prChipGlyph(pr)
  if (glyph) {
    const cx = rect.x + PAD_X + glyphSize(glyph) / 2
    drawGlyph(ctx, glyph, cx, midY, stateColor(glyph, colors), pulse)
  }
  ctx.font = chipFont(colors.font)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = style.ink
  ctx.fillText(`#${pr.number}`, rect.x + PAD_X + glyphAdvance(glyph), midY + 0.5)
}

function stateColor(glyph: Glyph, colors: PrChipColors): string {
  if (glyph === 'success') return colors.success
  if (glyph === 'pending') return colors.pending
  if (glyph === 'merged') return colors.merged
  if (glyph === 'draft') return colors.draft
  return colors.failure
}

/** A glyph centered on (cx, cy), at its badge size, in `color`. */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: Glyph,
  cx: number,
  cy: number,
  color: string,
  pulse: number
): void {
  const size = glyphSize(glyph)
  ctx.save()
  if (glyph === 'pending') {
    ctx.globalAlpha *= pulse
    ctx.beginPath()
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
    return
  }
  glyphPaths ??= {
    success: new Path2D(CHECK_D),
    failure: new Path2D(CROSS_D),
    merged: new Path2D(MERGED_D),
    closed: new Path2D(CLOSED_D),
    draft: new Path2D(DRAFT_D)
  }
  ctx.translate(cx - size / 2, cy - size / 2)
  if (isOcticon(glyph)) {
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
