// The PR chip a branch label wears: the canvas twin of the branch switcher's
// `#123` badge (.branch-pr in toolbar.css), so a PR reads the same everywhere
// in the app — only the leading glyph carries meaning: the CI rollup for an
// open PR (✓ passing, ✗ failing, amber dot running; nothing when no checks
// ran), GitHub's merged / closed octicon otherwise. Drawn in WORLD space inside
// the label pill, so it zooms with it.
//
// Unlike the badge it wears no pill of its own: a neutral patch on a tinted
// branch label reads as a foreign sticker, worst at small zoom where it blurs
// into a smudge. The chip is a hairline divider, the glyph and the number, all
// in the label's own ink. On a tinted label the label sits on an opaque,
// near-background base, so the mid-luminance state colors contrast as bare
// marks for every branch hue. The HEAD label is a solid accent fill that would
// swallow a green ✓, so there each glyph becomes a BADGE — a disc in the state
// color with the mark knocked out in the label's ink (GitHub's check-circle-fill
// idiom): the state color survives, and the chip stays as inline as the rest.

import type { PullRequestInfo } from '@shared/types'
import { PR_CHIP_GAP, PR_CHIP_H } from './geometry'

/** The state colors (render.ts readPalette), plus the font family. */
export interface PrChipColors {
  font: string
  success: string
  failure: string
  pending: string
  merged: string
}

/** How the chip sits in its label: its ink (number, and a badge's knocked-out
 *  mark), the divider's color, and whether glyphs are badged (HEAD's solid
 *  accent pill) or bare marks (tinted branch pills). */
export interface PrChipStyle {
  ink: string
  divider: string
  badged: boolean
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
    drawGlyph(ctx, glyph, x + GLYPH / 2, midY, stateColor(glyph, colors), style)
    x += GLYPH + GLYPH_GAP
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

/** How far a badge's knocked-out mark shrinks inside its disc. */
const BADGE_MARK_SCALE = 0.6

/** A GLYPH-sized state mark centered on (cx, cy): the bare mark in its state
 *  color, or — badged — a state-color disc with the mark in the label's ink. */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: Exclude<Glyph, null>,
  cx: number,
  cy: number,
  color: string,
  style: PrChipStyle
): void {
  ctx.save()
  ctx.translate(cx, cy)
  if (style.badged) {
    ctx.beginPath()
    ctx.arc(0, 0, GLYPH / 2 + 0.5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    // A running check is the disc alone — the amber IS the mark.
    if (glyph !== 'pending') {
      ctx.scale(BADGE_MARK_SCALE, BADGE_MARK_SCALE)
      drawMark(ctx, glyph, style.ink, 1.5 / BADGE_MARK_SCALE)
    }
  } else {
    drawMark(ctx, glyph, color, 1.5)
  }
  ctx.restore()
}

/** The state mark on a GLYPH box centered on the origin. */
function drawMark(
  ctx: CanvasRenderingContext2D,
  glyph: Exclude<Glyph, null>,
  color: string,
  lineWidth: number
): void {
  const h = GLYPH / 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = lineWidth
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.beginPath()
  if (glyph === 'success') {
    ctx.moveTo(-h * 0.76, h * 0.1)
    ctx.lineTo(-h * 0.2, h * 0.64)
    ctx.lineTo(h * 0.8, -h * 0.56)
    ctx.stroke()
  } else if (glyph === 'failure') {
    ctx.moveTo(-h * 0.6, -h * 0.6)
    ctx.lineTo(h * 0.6, h * 0.6)
    ctx.moveTo(h * 0.6, -h * 0.6)
    ctx.lineTo(-h * 0.6, h * 0.6)
    ctx.stroke()
  } else if (glyph === 'pending') {
    ctx.arc(0, 0, GLYPH * 0.33, 0, Math.PI * 2)
    ctx.fill()
  } else {
    octicons ??= { merged: new Path2D(MERGED_D), closed: new Path2D(CLOSED_D) }
    ctx.translate(-h, -h)
    ctx.scale(GLYPH / 16, GLYPH / 16)
    ctx.fill(glyph === 'merged' ? octicons.merged : octicons.closed)
  }
}
