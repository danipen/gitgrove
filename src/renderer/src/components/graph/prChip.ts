// The PR chip a branch label wears: the canvas twin of the branch switcher's
// `#123` badge (.branch-pr in toolbar.css), so a PR reads the same everywhere
// in the app — only the leading glyph carries meaning: the CI rollup for an
// open PR (✓ passing, ✗ failing, amber dot running; nothing when no checks
// ran), GitHub's merged / closed octicon otherwise. Drawn in WORLD space inside
// the label pill, so it zooms with it.
//
// Unlike the badge it wears no gray pill of its own: on a tinted branch label a
// neutral patch reads as a foreign sticker, worst at small zoom where it blurs
// into a gray smudge. The label already sits on an opaque, near-background base
// (a 15% hue tint), so the mid-luminance state glyphs contrast on it for every
// branch hue — the chip is just a hairline divider plus the glyph and a number
// in the branch's own ink. The one exception is the HEAD label: a solid accent
// fill that would swallow a green ✓, so there the chip insets a small
// label-surface pill to give the glyphs their ground back.

import type { PullRequestInfo } from '@shared/types'
import { PR_CHIP_GAP, PR_CHIP_H } from './geometry'

/** The chip's slice of the graph palette (render.ts readPalette). */
export interface PrChipColors {
  font: string
  /** The label surface (--bg-elevated): the HEAD chip's inset pill. */
  surface: string
  /** The inset chip's number ink. */
  text: string
  success: string
  failure: string
  pending: string
  merged: string
}

const CHIP_FONT = 10
const PAD_X = 4
const GLYPH = 9
const GLYPH_GAP = 2.5

// GitHub's merged / closed pull-request octicons on their 16-unit grid — the
// same paths as Icon.PrMerged / Icon.PrClosed (lib/icons.tsx). Built lazily:
// Path2D doesn't exist outside a browser (tests import this module).
const MERGED_D =
  'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z'
const CLOSED_D =
  'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm0 11a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM11.25 9.5a.75.75 0 0 1 .75.75v.378a2.251 2.251 0 1 1-1.5 0V10.25a.75.75 0 0 1 .75-.75Zm0 4a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM9.22 1.227a.75.75 0 0 1 1.06 0l.97.97.97-.97a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l.97-.97-.97-.97a.75.75 0 0 1 0-1.06Z'
let octicons: { merged: Path2D; closed: Path2D } | null = null

type Glyph = 'success' | 'failure' | 'pending' | 'merged' | 'closed' | null

/** The leading glyph for a PR — the badge's rule (BranchSwitcher PrGlyph). */
export function prChipGlyph(pr: PullRequestInfo): Glyph {
  if (pr.state === 'open') return pr.checks
  return pr.state
}

const chipFont = (family: string) => `500 ${CHIP_FONT}px ${family}`

/** How the chip sits in its label: `inline` on a tinted branch pill (divider,
 *  branch-ink number), `inset` on the solid HEAD pill (its own surface pill). */
export type PrChipStyle = { kind: 'inline'; ink: string; divider: string } | { kind: 'inset' }

/** The chip's width for `pr`, text measured in the chip font. */
export function measurePrChip(ctx: CanvasRenderingContext2D, family: string, pr: PullRequestInfo) {
  ctx.font = chipFont(family)
  const text = ctx.measureText(`#${pr.number}`).width
  return PAD_X * 2 + text + (prChipGlyph(pr) ? GLYPH + GLYPH_GAP : 0)
}

/** Paint the chip for `pr` into `rect` (world space, from geometry prChipRect). */
export function drawPrChip(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number },
  pr: PullRequestInfo,
  colors: PrChipColors,
  style: PrChipStyle
): void {
  if (style.kind === 'inset') {
    ctx.beginPath()
    ctx.roundRect(rect.x, rect.y, rect.w, PR_CHIP_H, PR_CHIP_H / 2 - 1)
    ctx.fillStyle = colors.surface
    ctx.fill()
  } else {
    // The hairline sits in the gap before the chip, a touch shorter than it.
    const x = Math.round(rect.x - PR_CHIP_GAP / 2) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, rect.y + 2)
    ctx.lineTo(x, rect.y + PR_CHIP_H - 2)
    ctx.strokeStyle = style.divider
    ctx.lineWidth = 1
    ctx.stroke()
  }

  const midY = rect.y + PR_CHIP_H / 2
  let x = rect.x + PAD_X
  const glyph = prChipGlyph(pr)
  if (glyph) {
    drawGlyph(ctx, glyph, x, midY - GLYPH / 2, colors)
    x += GLYPH + GLYPH_GAP
  }
  ctx.font = chipFont(colors.font)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = style.kind === 'inset' ? colors.text : style.ink
  ctx.fillText(`#${pr.number}`, x, midY + 0.5)
}

/** A GLYPH-sized state mark with its top-left at (x, y). */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: Exclude<Glyph, null>,
  x: number,
  y: number,
  colors: PrChipColors
): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 1.5
  const s = GLYPH
  if (glyph === 'success') {
    ctx.strokeStyle = colors.success
    ctx.beginPath()
    ctx.moveTo(x + s * 0.12, y + s * 0.55)
    ctx.lineTo(x + s * 0.4, y + s * 0.82)
    ctx.lineTo(x + s * 0.9, y + s * 0.22)
    ctx.stroke()
  } else if (glyph === 'failure') {
    ctx.strokeStyle = colors.failure
    ctx.beginPath()
    ctx.moveTo(x + s * 0.2, y + s * 0.2)
    ctx.lineTo(x + s * 0.8, y + s * 0.8)
    ctx.moveTo(x + s * 0.8, y + s * 0.2)
    ctx.lineTo(x + s * 0.2, y + s * 0.8)
    ctx.stroke()
  } else if (glyph === 'pending') {
    ctx.fillStyle = colors.pending
    ctx.beginPath()
    ctx.arc(x + s / 2, y + s / 2, s * 0.33, 0, Math.PI * 2)
    ctx.fill()
  } else {
    octicons ??= { merged: new Path2D(MERGED_D), closed: new Path2D(CLOSED_D) }
    ctx.fillStyle = glyph === 'merged' ? colors.merged : colors.failure
    ctx.translate(x, y)
    ctx.scale(s / 16, s / 16)
    ctx.fill(glyph === 'merged' ? octicons.merged : octicons.closed)
  }
  ctx.restore()
}
