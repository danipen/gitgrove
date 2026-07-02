// Canvas drawing for the Graph tab. Pure functions of a SceneState — all
// interaction state (pan/zoom, hover, selection) lives in GraphCanvas; all
// geometry in geometry.ts. Colors come from the design tokens at draw time so
// the diagram follows the active theme with zero extra plumbing.
//
// Visual language (GitKraken-inspired, calm): every branch is a rounded
// CONTAINER capsule in its own hue; its commits, spine, label and edges all
// carry that hue, so ownership is readable at a glance. Merge edges wear the
// SOURCE branch's color (what flowed in), fork edges the NEW branch's color
// (what split off).

import { avatarColor, initials } from '@/lib/avatar'
import { avatarImageFor } from './avatars'
import {
  CAPSULE_HALF_H,
  CAPSULE_PAD,
  CAPTION_MAX_SCREEN_W,
  CAPTION_SLOT_AIR,
  captionAlpha,
  captionCenterOffset,
  COL_W,
  columnsToNext,
  HEADER_H,
  labelRect,
  MARGIN_X,
  NODE_R,
  nodeX,
  nodeY,
  toWorldX,
  type View
} from './geometry'
import { BRANCH_COLOR_COUNT, type GraphLayout, type GraphNode, type GraphRow } from './layout'

export interface GraphPalette {
  dark: boolean
  font: string
  bg: string
  headerBg: string
  headerText: string
  headerLine: string
  accent: string
  onAccent: string
  halo: string
  match: string
  subject: string
  labelBg: string
  tag: string
}

/** Resolve the palette from the CSS design tokens on `el`'s computed style. */
export function readPalette(el: HTMLElement, dark: boolean): GraphPalette {
  const css = getComputedStyle(el)
  const token = (name: string) => css.getPropertyValue(name).trim()
  return {
    dark,
    font: css.fontFamily,
    bg: token('--bg'),
    headerBg: token('--bg-panel'),
    headerText: token('--fg-faint'),
    headerLine: token('--border'),
    accent: token('--accent'),
    onAccent: token('--on-accent'),
    halo: token('--accent-soft'),
    match: token('--st-modified'),
    subject: token('--fg-muted'),
    labelBg: token('--bg-elevated'),
    tag: token('--pr-merged')
  }
}

// One hue per palette slot; slot 0 (the mainline) is the app's blue family.
const BRANCH_HUES = [214, 286, 158, 24, 336, 190, 262, 96, 356]

const colorCache = new Map<string, string>()

function cached(key: string, make: () => string): string {
  let value = colorCache.get(key)
  if (!value) colorCache.set(key, (value = make()))
  return value
}

/** A branch slot's line/ring color, tuned per theme. */
export function branchStroke(palette: GraphPalette, slot: number): string {
  const hue = BRANCH_HUES[slot % BRANCH_COLOR_COUNT]
  return cached(`s${palette.dark}${slot}`, () =>
    palette.dark ? `hsl(${hue} 72% 64%)` : `hsl(${hue} 65% 44%)`
  )
}

/** A branch slot's text color (label pills), higher contrast than the stroke. */
function branchText(palette: GraphPalette, slot: number): string {
  const hue = BRANCH_HUES[slot % BRANCH_COLOR_COUNT]
  return cached(`t${palette.dark}${slot}`, () =>
    palette.dark ? `hsl(${hue} 85% 76%)` : `hsl(${hue} 75% 32%)`
  )
}

/** A branch slot's translucent fill (containers, label pills). */
function branchFill(palette: GraphPalette, slot: number, alpha: number): string {
  const hue = BRANCH_HUES[slot % BRANCH_COLOR_COUNT]
  const sl = palette.dark ? '72% 64%' : '65% 44%'
  return cached(`f${palette.dark}${slot}${alpha}`, () => `hsl(${hue} ${sl} / ${alpha})`)
}

/** A column where the (author-date) day changes — the header's day segments. */
export interface DayMark {
  column: number
  label: string
}

export function computeDayMarks(layout: GraphLayout): DayMark[] {
  const marks: DayMark[] = []
  let lastDay = ''
  for (const node of layout.nodes) {
    const day = new Date(node.commit.date).toLocaleDateString()
    if (day !== lastDay) {
      marks.push({ column: node.column, label: day })
      lastDay = day
    }
  }
  return marks
}

export interface SceneState {
  layout: GraphLayout
  view: View
  /** CSS-pixel canvas size (the backing store is `dpr` times larger). */
  width: number
  height: number
  dpr: number
  palette: GraphPalette
  selectedHash: string | null
  /** Tip hash of the branch whose changes view is open — its container lights up. */
  selectedBranchTip: string | null
  hoverHash: string | null
  /** Commits kept at full strength while everything else dims (filters/search),
   *  or null when nothing is filtering. */
  matches: ReadonlySet<string> | null
  /** The current search hit, ringed louder than its fellow matches. */
  activeMatch: string | null
  wip: { column: number; row: number; count: number; color: number } | null
  dayMarks: DayMark[]
}

const LABEL_FONT = 11
/** Caption font in SCREEN px: captions render map-label style — a constant
 *  on-screen size at any zoom. Size and weight must mirror .graph-tip__subject
 *  in graph.css exactly: the expansion card's first line sits on the caption's
 *  glyphs, and only a matching font makes the truncated text visibly "become"
 *  the full message. Captions therefore draw in SCREEN space (see drawCaption)
 *  so they rasterize at this exact pixel size, like the DOM text does. */
export const SUBJECT_FONT = 13
export const SUBJECT_WEIGHT = 600
const DIM_ALPHA = 0.15

/** Font metrics of the caption face, for baseline-exact DOM overlays. */
export interface CaptionMetrics {
  /** Font-box ascent/descent — what CSS line layout uses as the content area. */
  ascent: number
  descent: number
  /** Distance from the canvas 'middle' anchor down to the alphabetic baseline. */
  middleToBaseline: number
}

let captionMetricsCache: (CaptionMetrics & { font: string }) | null = null

/** Measure the caption font once (per family): the hover card is positioned
 *  off these metrics so its first line's baseline lands exactly on the canvas
 *  caption's baseline — guessed offsets drift by a pixel across platforms. */
export function captionMetrics(fontFamily: string): CaptionMetrics {
  if (captionMetricsCache?.font === fontFamily) return captionMetricsCache
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) {
    // No 2D context (tests): sane estimates for a 12px UI face.
    return { ascent: SUBJECT_FONT * 0.96, descent: SUBJECT_FONT * 0.25, middleToBaseline: 3.6 }
  }
  ctx.font = `${SUBJECT_WEIGHT} ${SUBJECT_FONT}px ${fontFamily}`
  ctx.textBaseline = 'alphabetic'
  const fromBaseline = ctx.measureText('Mg')
  ctx.textBaseline = 'middle'
  const fromMiddle = ctx.measureText('Mg')
  captionMetricsCache = {
    font: fontFamily,
    ascent: fromBaseline.fontBoundingBoxAscent,
    descent: fromBaseline.fontBoundingBoxDescent,
    // TextMetrics are relative to the active textBaseline, so the ascent
    // difference IS the middle→alphabetic baseline distance.
    middleToBaseline: fromBaseline.fontBoundingBoxAscent - fromMiddle.fontBoundingBoxAscent
  }
  return captionMetricsCache
}

// Measured pill-text widths, shared with hit-testing (see labelWidthFor).
const labelWidths = new Map<string, number>()

/** Width of a row's label text as last measured; an estimate before first draw. */
export function labelWidthFor(name: string): number {
  return labelWidths.get(name) ?? name.length * 6.2
}

// Caption widths (SCREEN px) as last drawn, keyed by commit hash; 0 = culled.
const captionWidths = new Map<string, number>()

/** SCREEN width a node's caption actually drew this frame — hit-testing hovers
 *  exactly the glyphs, so a short subject's (or a culled caption's) empty slot
 *  never pops the message card while the mouse crosses edge lines. */
export function captionWidthFor(hash: string): number | undefined {
  return captionWidths.get(hash)
}

const dimmed = (scene: SceneState, hash: string): boolean =>
  scene.matches !== null && !scene.matches.has(hash)

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo === 0 ? '' : `${text.slice(0, lo)}…`
}

/** A branch label's frame geometry: where its pill draws this frame, and
 *  whether it is riding the viewport edge (sticky) rather than at rest. */
interface LabelBox {
  row: GraphRow
  rect: { x: number; y: number; w: number; h: number }
  sticky: boolean
}

/** Measure every label and resolve its (possibly sticky) rect for this frame.
 *  Runs before nodes draw, so tag chips can yield to overlapping labels. */
function computeLabelBoxes(ctx: CanvasRenderingContext2D, scene: SceneState): LabelBox[] {
  const { palette, view } = scene
  if (view.scale < 0.4) return []
  const leftClamp = toWorldX(view, 8)
  ctx.font = `600 ${LABEL_FONT}px ${palette.font}`
  return scene.layout.rows.map((row) => {
    const width = ctx.measureText(row.name).width
    labelWidths.set(row.name, width)
    const rect = labelRect(row, width, leftClamp)
    return { row, rect, sticky: rect.x > nodeX(row.startColumn) - NODE_R + 0.5 }
  })
}

const intersects = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export function drawScene(ctx: CanvasRenderingContext2D, scene: SceneState): void {
  const { view, width, dpr } = scene
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, scene.height)

  // Visible column range (with a one-column apron) for culling.
  const c0 = Math.floor((toWorldX(view, 0) - MARGIN_X) / COL_W) - 1
  const c1 = Math.ceil((toWorldX(view, width) - MARGIN_X) / COL_W) + 1

  // World transform for everything but the sticky header.
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // The hover card's DOM text inherits body's `text-rendering:
  // optimizeLegibility`; mirror it so canvas captions shape with the same
  // kerning/ligatures — different shaping shows as a shift on hover.
  ctx.textRendering = 'optimizeLegibility'

  const labelBoxes = computeLabelBoxes(ctx, scene)
  drawDayLines(ctx, scene)
  drawContainers(ctx, scene, c0, c1)
  drawEdges(ctx, scene, c0, c1)
  drawNodes(ctx, scene, c0, c1, labelBoxes)
  drawWip(ctx, scene)
  drawLabels(ctx, scene, labelBoxes)

  drawHeader(ctx, scene)
}

function drawDayLines(ctx: CanvasRenderingContext2D, scene: SceneState): void {
  const { view, height, palette } = scene
  const yTop = (HEADER_H - view.y) / view.scale
  const yBottom = (height - view.y) / view.scale
  ctx.strokeStyle = palette.headerLine
  ctx.lineWidth = 1 / view.scale
  ctx.globalAlpha = 0.45
  for (const mark of scene.dayMarks) {
    const x = nodeX(mark.column) - COL_W / 2
    ctx.beginPath()
    ctx.moveTo(x, yTop)
    ctx.lineTo(x, yBottom)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Branch capsules plus their spines — the containers commits live in. */
function drawContainers(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  c0: number,
  c1: number
): void {
  const { palette, wip } = scene
  for (const row of scene.layout.rows) {
    if (row.endColumn < c0 - 1 || row.startColumn > c1 + 1) continue
    const selected = row.tipHash === scene.selectedBranchTip
    const y = nodeY(row.index)
    const x0 = nodeX(row.startColumn) - NODE_R - CAPSULE_PAD
    // The HEAD branch's capsule stretches to embrace the WIP node.
    const lastColumn = row.isHead && wip ? wip.column : row.endColumn
    const x1 = nodeX(lastColumn) + NODE_R + CAPSULE_PAD
    if (selected) {
      // Exactly the commit treatment: soft halo behind, and the accent ring
      // drawn AROUND the capsule — its own branch-colored border stays as is.
      ctx.beginPath()
      ctx.roundRect(
        x0 - 8,
        y - CAPSULE_HALF_H - 8,
        x1 - x0 + 16,
        CAPSULE_HALF_H * 2 + 16,
        CAPSULE_HALF_H + 8
      )
      ctx.fillStyle = palette.halo
      ctx.fill()
      ctx.beginPath()
      ctx.roundRect(
        x0 - 4,
        y - CAPSULE_HALF_H - 4,
        x1 - x0 + 8,
        CAPSULE_HALF_H * 2 + 8,
        CAPSULE_HALF_H + 4
      )
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.roundRect(x0, y - CAPSULE_HALF_H, x1 - x0, CAPSULE_HALF_H * 2, CAPSULE_HALF_H)
    ctx.fillStyle = branchFill(palette, row.color, 0.06)
    ctx.fill()
    ctx.strokeStyle = branchFill(palette, row.color, 0.28)
    ctx.lineWidth = 1
    ctx.stroke()
    // Spine through the chain's commits, in the branch color. While a filter
    // dims commits, the structure lines recede with them — matches must pop.
    if (row.endColumn > row.startColumn) {
      ctx.strokeStyle = branchStroke(palette, row.color)
      ctx.globalAlpha = scene.matches ? 0.2 : 0.85
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(nodeX(row.startColumn), y)
      ctx.lineTo(nodeX(row.endColumn), y)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  c0: number,
  c1: number
): void {
  const { palette, matches } = scene
  ctx.lineWidth = 2
  for (const edge of scene.layout.edges) {
    if (edge.kind === 'line') continue // covered by the branch spine
    if (Math.max(edge.fromColumn, edge.toColumn) < c0) continue
    if (Math.min(edge.fromColumn, edge.toColumn) > c1) continue
    // With a filter active, an edge stays lit only between two matches;
    // everything else recedes with the dimmed nodes it connects.
    const lit = !matches || (matches.has(edge.fromHash) && matches.has(edge.toHash))
    // Parent (older, left) → child (newer, right).
    const px = nodeX(edge.toColumn)
    const py = nodeY(edge.toRow)
    const cx = nodeX(edge.fromColumn)
    const cy = nodeY(edge.fromRow)
    ctx.strokeStyle = branchStroke(palette, edge.color)
    ctx.globalAlpha = lit ? 0.8 : 0.12
    ctx.beginPath()
    if (py === cy) {
      // Same-row hop (criss-cross merge / packed-row fork): a shallow arc.
      ctx.moveTo(px, py - NODE_R)
      ctx.quadraticCurveTo((px + cx) / 2, py - CAPSULE_HALF_H - 14, cx, cy - NODE_R)
    } else if (edge.kind === 'fork') {
      // Orthogonal, Plastic-style: drop straight down/up the fork column,
      // then run along the child's row into its first commit. Long runs
      // travel along lanes or columns — never diagonally across the canvas.
      // The elbow sweeps wide (up to ~2/3 of each leg) so the turn reads as
      // one soft curve rather than a hard pipe corner.
      const dir = Math.sign(cy - py)
      const r = Math.min(120, Math.abs(cx - px) * 0.66, Math.abs(cy - py) * 0.66)
      ctx.moveTo(px, py + dir * NODE_R)
      ctx.lineTo(px, cy - dir * r)
      ctx.quadraticCurveTo(px, cy, px + r, cy)
      ctx.lineTo(cx - NODE_R, cy)
    } else {
      // Merge: run along the source branch's row (its lead-out — the packing
      // reserved this stretch), then straight into the merge commit's column.
      const dir = Math.sign(cy - py)
      const r = Math.min(120, Math.abs(cx - px) * 0.66, Math.abs(cy - py) * 0.66)
      ctx.moveTo(px + NODE_R, py)
      ctx.lineTo(cx - r, py)
      ctx.quadraticCurveTo(cx, py, cx, py + dir * r)
      ctx.lineTo(cx, cy - dir * NODE_R)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  c0: number,
  c1: number,
  labelBoxes: LabelBox[]
): void {
  const { layout, palette, view } = scene
  const showText = view.scale >= 0.55
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const node of layout.nodes) {
    if (node.column < c0) continue
    if (node.column > c1) break
    const x = nodeX(node.column)
    const y = nodeY(node.row)
    const dim = dimmed(scene, node.commit.hash)
    ctx.globalAlpha = dim ? DIM_ALPHA : 1

    if (node.truncated) {
      ctx.strokeStyle = branchStroke(palette, node.color)
      ctx.setLineDash([3, 3])
      ctx.lineWidth = 1.5
      ctx.globalAlpha = dim ? DIM_ALPHA : 0.6
      ctx.beginPath()
      ctx.moveTo(x - NODE_R - 22, y)
      ctx.lineTo(x - NODE_R, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = dim ? DIM_ALPHA : 1
    }

    // Opaque backing disc: edges and spines terminate BEHIND the commit, so
    // a dimmed (translucent) node never shows lines through its face.
    ctx.globalAlpha = 1
    ctx.fillStyle = palette.bg
    ctx.beginPath()
    ctx.arc(x, y, NODE_R + 1.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = dim ? DIM_ALPHA : 1

    // Selection halo, under everything else on the node.
    const isSelected = node.commit.hash === scene.selectedHash
    if (isSelected) {
      ctx.fillStyle = palette.halo
      ctx.beginPath()
      ctx.arc(x, y, NODE_R + 8, 0, Math.PI * 2)
      ctx.fill()
    }

    // Face: colored initials disc, covered by the avatar image once loaded.
    const image = avatarImageFor(node.commit.authorName, node.commit.authorEmail)
    ctx.beginPath()
    ctx.arc(x, y, NODE_R, 0, Math.PI * 2)
    if (image) {
      ctx.save()
      ctx.clip()
      ctx.drawImage(image, x - NODE_R, y - NODE_R, NODE_R * 2, NODE_R * 2)
      ctx.restore()
    } else {
      ctx.fillStyle = avatarColor(node.commit.authorEmail || node.commit.authorName)
      ctx.fill()
      if (showText) {
        ctx.fillStyle = '#fff'
        ctx.font = `600 9px ${palette.font}`
        ctx.fillText(initials(node.commit.authorName, node.commit.authorEmail), x, y + 0.5)
      }
    }

    // Ring in the branch color; louder states stack on top.
    const isActiveMatch = node.commit.hash === scene.activeMatch
    const isHover = node.commit.hash === scene.hoverHash
    ctx.lineWidth = isHover || isActiveMatch ? 2.5 : 2
    ctx.strokeStyle = isActiveMatch ? palette.match : branchStroke(palette, node.color)
    ctx.beginPath()
    ctx.arc(x, y, NODE_R + 0.5, 0, Math.PI * 2)
    ctx.stroke()
    if (isSelected || node.isHead) {
      // Outer ring: accent — "you are here" (HEAD) and "this is picked".
      ctx.lineWidth = 2
      ctx.strokeStyle = palette.accent
      ctx.beginPath()
      ctx.arc(x, y, NODE_R + 4, 0, Math.PI * 2)
      ctx.stroke()
    }

    if (showText) drawNodeText(ctx, scene, node, x, y, labelBoxes)
    ctx.globalAlpha = 1
  }
}

/** Caption text (commit subjects, the WIP "uncommitted") drawn in SCREEN space
 *  at the exact CSS pixel size. Under the world transform the text would shape
 *  at a fractional size (SUBJECT_FONT / scale) and have its advances scaled
 *  back up — close to, but measurably different from, native 12px shaping. The
 *  hover card renders the same string as DOM text at 12px, so only shaping at
 *  the same size keeps the two rasterizations glyph-for-glyph identical: the
 *  caption must not move a subpixel when the card appears over it.
 *  Returns the drawn text's SCREEN width (0 when culled) for hit-testing. */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  text: string,
  worldX: number,
  /** The ROW's center y — the caption anchors a screen-fixed gap below the
   *  capsule edge (captionCenterOffset), so the margin between capsule and
   *  text is identical at every zoom instead of scaling with it. */
  rowCenterY: number,
  maxWorldWidth: number
): number {
  const { view, dpr, palette } = scene
  // All-or-nothing (see geometry.ts): the whole layer fades below the zoom
  // where the tightest slot goes unreadable — never caption by caption.
  const reveal = captionAlpha(view.scale)
  if (reveal === 0) return 0
  const maxScreenWidth = Math.min(maxWorldWidth * view.scale, CAPTION_MAX_SCREEN_W)
  if (maxScreenWidth <= 0) return 0
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = `${SUBJECT_WEIGHT} ${SUBJECT_FONT}px ${palette.font}`
  ctx.textAlign = 'left'
  const fitted = truncate(ctx, text, maxScreenWidth)
  let width = 0
  if (fitted) {
    width = ctx.measureText(fitted).width
    ctx.globalAlpha *= reveal
    ctx.fillStyle = palette.subject
    const y = (rowCenterY + captionCenterOffset(view.scale)) * view.scale + view.y
    ctx.fillText(fitted, worldX * view.scale + view.x, y)
  }
  ctx.restore()
  return width
}

/** Truncated subject under the node, sized to the gap before the next node. */
function drawNodeText(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  node: GraphNode,
  x: number,
  y: number,
  labelBoxes: LabelBox[]
): void {
  const { palette, wip } = scene
  let gap = columnsToNext(scene.layout, node)
  // The WIP node occupies the column after the HEAD tip but isn't a commit —
  // its "uncommitted" caption bounds the tip's subject like any neighbor's
  // (both captions are left-aligned on their node's left edge).
  if (wip && wip.row === node.row && wip.column > node.column) {
    gap = Math.min(gap, wip.column - node.column)
  }
  const maxWidth = Math.min(gap * COL_W - CAPTION_SLOT_AIR, COL_W * 3.4)
  captionWidths.set(
    node.commit.hash,
    drawCaption(ctx, scene, node.commit.subject, x - NODE_R, y, maxWidth)
  )
  const tags = node.refs.filter((r) => r.isTag)
  if (tags.length > 0) {
    // A small bordered chip above the node — drawn, not a unicode glyph (those
    // render as tofu boxes in some font stacks).
    ctx.font = `600 10px ${palette.font}`
    const label = tags.map((t) => t.name).join('  ')
    const w = ctx.measureText(label).width + 10
    const chip = { x: x - w / 2, y: y - NODE_R - 22, w, h: 15 }
    // Tag chips share the label band; a sticky label sliding over one wins —
    // the chip yields and reappears as the user pans on.
    if (labelBoxes.some((b) => b.sticky && intersects(b.rect, chip))) return
    ctx.beginPath()
    ctx.roundRect(chip.x, chip.y, chip.w, chip.h, 4)
    ctx.fillStyle = palette.labelBg
    ctx.fill()
    ctx.strokeStyle = palette.tag
    ctx.lineWidth = 1
    ctx.globalAlpha *= 0.8
    ctx.stroke()
    ctx.globalAlpha = dimmed(scene, node.commit.hash) ? DIM_ALPHA : 1
    ctx.fillStyle = palette.tag
    ctx.fillText(label, x, chip.y + 8)
  }
}

function drawWip(ctx: CanvasRenderingContext2D, scene: SceneState): void {
  const { palette } = scene
  if (!scene.wip) return
  const { column, row, count, color } = scene.wip
  const x = nodeX(column)
  const y = nodeY(row)
  const tipX = nodeX(column - 1)
  ctx.strokeStyle = branchStroke(palette, color)
  ctx.setLineDash([3, 3])
  ctx.lineWidth = 1.5
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.moveTo(tipX + NODE_R, y)
  ctx.lineTo(x - NODE_R, y)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y, NODE_R, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  ctx.fillStyle = palette.subject
  ctx.font = `600 10px ${palette.font}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 99 ? '99+' : `+${count}`, x, y + 0.5)
  // Placed exactly like a commit's caption — same size, weight, capsule gap
  // and left edge — so the WIP node reads as one more entry in the chain.
  drawCaption(ctx, scene, 'uncommitted', x - NODE_R, y, COL_W * 3.4)
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  labelBoxes: LabelBox[]
): void {
  const { palette } = scene
  ctx.font = `600 ${LABEL_FONT}px ${palette.font}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  for (const { row, rect, sticky } of labelBoxes) {
    const head = row.isHead
    ctx.globalAlpha = row.kind === 'unnamed' ? 0.8 : 1
    ctx.beginPath()
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 5)
    // A sticky pill floats over diagram content — a soft shadow makes the
    // layering read as deliberate.
    if (sticky) {
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'
      ctx.shadowBlur = 6
      ctx.shadowOffsetY = 1
      ctx.fillStyle = palette.labelBg
      ctx.fill()
      ctx.restore()
    } else {
      // Opaque base so day lines never bleed through the tinted pill.
      ctx.fillStyle = palette.labelBg
      ctx.fill()
    }
    ctx.fillStyle = head ? palette.accent : branchFill(palette, row.color, 0.15)
    ctx.fill()
    if (!head) {
      ctx.strokeStyle = branchFill(palette, row.color, 0.55)
      ctx.lineWidth = 1
      if (row.kind === 'unnamed') ctx.setLineDash([3, 2])
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.fillStyle = head ? palette.onAccent : branchText(palette, row.color)
    ctx.fillText(row.name, rect.x + 8, rect.y + rect.h / 2 + 0.5)
    ctx.globalAlpha = 1
  }
}

/** Screen-space sticky date header, panning horizontally with the diagram. */
function drawHeader(ctx: CanvasRenderingContext2D, scene: SceneState): void {
  const { view, width, dpr, palette } = scene
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = palette.headerBg
  ctx.fillRect(0, 0, width, HEADER_H)
  ctx.strokeStyle = palette.headerLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, HEADER_H - 0.5)
  ctx.lineTo(width, HEADER_H - 0.5)
  ctx.stroke()

  ctx.fillStyle = palette.headerText
  ctx.font = `11px ${palette.font}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const marks = scene.dayMarks
  for (let i = 0; i < marks.length; i++) {
    const x = (nodeX(marks[i].column) - COL_W / 2) * view.scale + view.x
    const next =
      i + 1 < marks.length
        ? (nodeX(marks[i + 1].column) - COL_W / 2) * view.scale + view.x
        : width
    if (next < 6 || x > width) continue
    if (x >= 0) {
      ctx.strokeStyle = palette.headerLine
      ctx.beginPath()
      ctx.moveTo(x + 0.5, 4)
      ctx.lineTo(x + 0.5, HEADER_H - 4)
      ctx.stroke()
    }
    // Pin the label to the left edge while its day segment is still on screen,
    // so the current day is always readable mid-pan.
    const labelX = Math.max(x, 0) + 6
    const label = truncate(ctx, marks[i].label, Math.max(0, next - labelX - 6))
    if (label) ctx.fillText(label, labelX, HEADER_H / 2 + 0.5)
  }
}
