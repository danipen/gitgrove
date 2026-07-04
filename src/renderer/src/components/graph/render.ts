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
  CAPTION_HOME_MAX_SCREEN_W,
  CAPTION_MAX_SCREEN_W,
  CAPTION_SLOT_AIR,
  COL_W,
  captionAlpha,
  captionCenterOffset,
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
import {
  BRANCH_COLOR_COUNT,
  type BranchSelection,
  type GraphLayout,
  type GraphNode,
  type GraphRow,
  rowMatchesSelection
} from './layout'
import { type BackportLink, linkedHashes } from './links'
import {
  ACTIVE_GLOW,
  HIT_GLOW,
  litChains,
  pingRings,
  type SearchHit,
  withAlpha
} from './searchGlow'

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
  if (!value) {
    value = make()
    colorCache.set(key, value)
  }
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
  /** The branch whose changes view is open — its container lights up. */
  selectedBranch: BranchSelection | null
  hoverHash: string | null
  /** Commits kept at full strength while everything else dims (filters/search),
   *  or null when nothing is filtering. */
  matches: ReadonlySet<string> | null
  /** The current search hit — a commit node, a branch LABEL, or a tag chip;
   *  it wears the loud treatment its fellow hits wear softly. */
  activeHit: SearchHit | null
  /** Chains whose branch label is itself a hit; null = not searching. */
  hitBranches: ReadonlySet<number> | null
  /** Commits whose tag chip is a hit; null = not searching. */
  hitTags: ReadonlySet<string> | null
  /** The current hit's arrival ping: 0 = just landed … 1 = settled (no ping).
   *  GraphCanvas animates it over PING_MS whenever the hit changes. */
  matchPulse: number
  wip: { column: number; row: number; count: number; color: number } | null
  dayMarks: DayMark[]
  /** Dashed "same change" links between backport twins (see links.ts). */
  links: readonly BackportLink[]
}

const LABEL_FONT = 11
/** Breathing room the day-header label keeps from its segment's right boundary
 *  so it never touches the next day's label (drawHeader). */
const HEADER_LABEL_PAD = 6
/** Caption font in SCREEN px: captions render map-label style — a constant
 *  on-screen size at any zoom. Size and weight must mirror .graph-tip__subject
 *  in graph.css exactly: the expansion card's first line sits on the caption's
 *  glyphs, and only a matching font makes the truncated text visibly "become"
 *  the full message. Captions therefore draw in SCREEN space (see drawCaption)
 *  so they rasterize at this exact pixel size, like the DOM text does. */
export const SUBJECT_FONT = 13
export const SUBJECT_WEIGHT = 600
const DIM_ALPHA = 0.15
/** Ghosted branch labels (no hit on the chain): stronger than DIM_ALPHA — a
 *  label is a wayfinding anchor, it must stay locatable while receding. */
const LABEL_GHOST_ALPHA = 0.25

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
  drawBackportLinks(ctx, scene, c0, c1)
  drawNodes(ctx, scene, c0, c1, labelBoxes, twinsOf(scene.links))
  drawWip(ctx, scene)
  drawEmptyHeadBadge(ctx, scene, c0, c1)
  drawLabels(ctx, scene, labelBoxes, litChainsFor(scene))

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
    const selected = rowMatchesSelection(row, scene.selectedBranch)
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

function drawEdges(ctx: CanvasRenderingContext2D, scene: SceneState, c0: number, c1: number): void {
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
      const controlY = py - CAPSULE_HALF_H - 14
      ctx.moveTo(px, py - NODE_R)
      ctx.quadraticCurveTo((px + cx) / 2, controlY, cx, cy - NODE_R)
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

// Chains holding at least one filter/search match, cached per matches set
// (stable between frames) so the 60fps pan path never re-derives it.
const litChainsCache = new WeakMap<ReadonlySet<string>, ReadonlySet<number>>()
function litChainsFor(scene: SceneState): ReadonlySet<number> | null {
  const { matches } = scene
  if (matches === null) return null
  let lit = litChainsCache.get(matches)
  if (!lit) {
    // hitBranches shares the matches set's lifetime (both derive from the
    // same search recompute), so keying the cache on matches alone is safe.
    lit = litChains(scene.layout.nodes, matches, scene.hitBranches)
    litChainsCache.set(matches, lit)
  }
  return lit
}

// Twin markers: which commits participate in any link. Cached per links array
// (stable between frames) so the 60fps pan path never re-derives the set.
const twinCache = new WeakMap<readonly BackportLink[], ReadonlySet<string>>()
function twinsOf(links: readonly BackportLink[]): ReadonlySet<string> | null {
  if (links.length === 0) return null
  let twins = twinCache.get(links)
  if (!twins) {
    twins = linkedHashes(links)
    twinCache.set(links, twins)
  }
  return twins
}

/** Dashed "same change" links: the same patch-id living on two lines — a
 *  cherry-picked backport. A real release branch shares dozens of changes
 *  with the mainline, so all-pairs-at-once is spaghetti; instead every twin
 *  commit wears a quiet dot (drawNodes) and the curve draws ONLY for the
 *  hovered or selected commit. Flowing bezier in the tag hue, deliberately
 *  unlike the orthogonal ancestry pipes, so equivalence never reads as
 *  parentage. */
function drawBackportLinks(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  c0: number,
  c1: number
): void {
  if (scene.links.length === 0) return
  if (scene.selectedHash === null && scene.hoverHash === null) return
  const { layout, palette } = scene
  const active = (hash: string) => hash === scene.selectedHash || hash === scene.hoverHash
  ctx.setLineDash([5, 4])
  for (const link of scene.links) {
    if (!active(link.fromHash) && !active(link.toHash)) continue
    const from = layout.nodeByHash.get(link.fromHash)
    const to = layout.nodeByHash.get(link.toHash)
    if (!from || !to) continue
    if (Math.max(from.column, to.column) < c0) continue
    if (Math.min(from.column, to.column) > c1) continue
    const x0 = nodeX(from.column)
    const y0 = nodeY(from.row)
    const x1 = nodeX(to.column)
    const y1 = nodeY(to.row)
    ctx.strokeStyle = palette.tag
    ctx.globalAlpha = 0.95
    ctx.lineWidth = 2
    ctx.beginPath()
    if (y0 === y1) {
      // Two chains sharing a packed row: a shallow arc, like same-row edges.
      ctx.moveTo(x0, y0 - NODE_R)
      ctx.quadraticCurveTo((x0 + x1) / 2, y0 - CAPSULE_HALF_H - 18, x1, y1 - NODE_R)
    } else {
      const dir = Math.sign(y1 - y0)
      const midY = (y0 + y1) / 2
      ctx.moveTo(x0, y0 + dir * NODE_R)
      ctx.bezierCurveTo(x0, midY, x1, midY, x1, y1 - dir * NODE_R)
    }
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  c0: number,
  c1: number,
  labelBoxes: LabelBox[],
  twins: ReadonlySet<string> | null
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
    // a dimmed (translucent) node never shows lines through its face. Merge
    // nodes wear a second ring but keep the same outer size as every other
    // node (see below), so they share the same backing disc — every line
    // docks at the ring's outer edge.
    ctx.globalAlpha = 1
    ctx.fillStyle = palette.bg
    ctx.beginPath()
    ctx.arc(x, y, NODE_R + 1.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = dim ? DIM_ALPHA : 1

    // Commit hits wear the text-editor find treatment, in gold: every hit a
    // soft radial glow behind the node, the CURRENT hit a wider corona (plus
    // a ring and an arrival ping, below). Gold, not the branch hue — hits
    // must read across all branch colors at a glance. The glow fades to a
    // zero-alpha stop of the SAME color: fading to `transparent` would drag
    // the gradient through black and dirty the halo's rim. (Branch and tag
    // hits glow their pill/chip instead — drawLabels / drawNodeText.)
    const isActiveMatch =
      scene.activeHit?.kind === 'commit' && scene.activeHit.hash === node.commit.hash
    const isHit = scene.activeHit !== null && scene.matches?.has(node.commit.hash) === true
    if (isHit) {
      const glowR = NODE_R + (isActiveMatch ? ACTIVE_GLOW : HIT_GLOW)
      const glow = ctx.createRadialGradient(x, y, NODE_R - 2, x, y, glowR)
      glow.addColorStop(0, withAlpha(palette.match, isActiveMatch ? 0.55 : 0.35))
      glow.addColorStop(1, withAlpha(palette.match, 0))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(x, y, glowR, 0, Math.PI * 2)
      ctx.fill()
    }

    // Selection halo, under everything else on the node.
    const isSelected = node.commit.hash === scene.selectedHash
    if (isSelected) {
      ctx.fillStyle = palette.halo
      ctx.beginPath()
      ctx.arc(x, y, NODE_R + 8, 0, Math.PI * 2)
      ctx.fill()
    }

    // Face: colored initials disc, covered by the avatar image once loaded.
    // Merge nodes carry a second (inner) ring, so their face shrinks to sit
    // inside it — the ring frames the avatar instead of cutting across it. The
    // face reaches the inner ring's inner edge (10 − 0.75) with the same 0.5px
    // overlap a normal node's ring has, so the ring sits ON the avatar edge
    // with no hairline of background between them.
    const faceR = node.mergeColor !== null ? NODE_R - 2.25 : NODE_R
    const image = avatarImageFor(node.commit.authorName, node.commit.authorEmail)
    ctx.beginPath()
    ctx.arc(x, y, faceR, 0, Math.PI * 2)
    if (image) {
      ctx.save()
      ctx.clip()
      ctx.drawImage(image, x - faceR, y - faceR, faceR * 2, faceR * 2)
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

    // Ring in the branch color; louder states stack on top. The current hit
    // keeps its branch/merge ring — the gold glow and corona carry the find
    // state, so branch identity (and the merge ring's incoming-color rule)
    // survive being the current match.
    const isHover = node.commit.hash === scene.hoverHash
    const emphasized = isHover || isActiveMatch
    if (node.mergeColor !== null) {
      // Merge nodes carry TWO concentric rings, but both are squeezed into the
      // footprint of a single ring so a merge commit is exactly the same size
      // as every other node — no ballooning. The outer ring is the INCOMING
      // branch's color, sitting at the normal ring radius where the merge edge
      // docks: the green line docks into a green ring, so a merge link can
      // never be misread as a fork link. This node's own branch color tucks
      // just inside it, a hair of background between them.
      ctx.lineWidth = 1.5
      ctx.strokeStyle = branchStroke(palette, node.color)
      ctx.beginPath()
      ctx.arc(x, y, NODE_R - 2, 0, Math.PI * 2)
      ctx.stroke()
      ctx.lineWidth = emphasized ? 2.5 : 2
      ctx.strokeStyle = branchStroke(palette, node.mergeColor)
      ctx.beginPath()
      ctx.arc(x, y, NODE_R + 0.5, 0, Math.PI * 2)
      ctx.stroke()
    } else {
      ctx.lineWidth = emphasized ? 2.5 : 2
      ctx.strokeStyle = branchStroke(palette, node.color)
      ctx.beginPath()
      ctx.arc(x, y, NODE_R + 0.5, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (isActiveMatch) {
      // The current hit's gold corona ring — the same radius and weight as
      // the selection ring, so "current find" and "selected" speak one
      // grammar in two colors. When a hit is also selected, the accent ring
      // (drawn below) wins the radius and the gold glow still marks the find.
      ctx.lineWidth = 2
      ctx.strokeStyle = palette.match
      ctx.beginPath()
      ctx.arc(x, y, NODE_R + 4, 0, Math.PI * 2)
      ctx.stroke()
      // Arrival ping: staggered expanding rings that fade as they travel —
      // the eye is drawn by motion exactly once, then the steady corona
      // holds the spot (pingRings returns [] once settled).
      for (const ring of pingRings(scene.matchPulse)) {
        ctx.globalAlpha = ring.alpha
        ctx.lineWidth = ring.width
        ctx.beginPath()
        ctx.arc(x, y, NODE_R + 4 + ring.grow, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = dim ? DIM_ALPHA : 1
    }
    if (isSelected) {
      // Outer accent ring: "this is picked" — selection only. The home
      // changeset wears the house badge below instead, so being at home
      // never *looks* like a selection. Merge nodes are the same size now, so
      // it sits at the same radius for every node.
      ctx.lineWidth = 2
      ctx.strokeStyle = palette.accent
      ctx.beginPath()
      ctx.arc(x, y, NODE_R + 4, 0, Math.PI * 2)
      ctx.stroke()
    }
    // Backport twin dot: this change also lives on another line — hover or
    // select to see the dashed link. Restraint is the design: a presence-dot
    // on the lower shoulder (backed by a bg disc for contrast on any avatar),
    // sized to be legible when you look and ignorable when you don't, and
    // culled below the same zoom where node text vanishes — an overview must
    // never turn into a field of specks. Rings are taken (branch color,
    // selection, match), so a badge, not another ring. It brightens with its
    // node's hover/selection, exactly when the curve appears.
    if (twins?.has(node.commit.hash) && showText) {
      const bx = x + NODE_R * 0.78
      const by = y + NODE_R * 0.78
      ctx.fillStyle = palette.bg
      ctx.beginPath()
      ctx.arc(bx, by, 3.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = palette.tag
      if (!dim) ctx.globalAlpha = isHover || isSelected ? 1 : 0.7
      ctx.beginPath()
      ctx.arc(bx, by, 2.1, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = dim ? DIM_ALPHA : 1
    }
    if (node.isHead) drawHomeBadge(ctx, scene, x, y)

    if (showText) drawNodeText(ctx, scene, node, x, y, labelBoxes)
    ctx.globalAlpha = 1
  }
}

/** HEAD on a zero-commit branch: no node carries isHead (layout moves it to
 *  the empty lane's row), so the home badge anchors to the lane's reserved
 *  slot — where the branch's first commit will land. Centered in the slot,
 *  not on the shoulder: the shoulder spot sits right under the accent label
 *  pill, and blue-on-blue melts the badge into it. */
function drawEmptyHeadBadge(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  c0: number,
  c1: number
): void {
  for (const row of scene.layout.rows) {
    if (!row.empty || !row.isHead) continue
    if (row.endColumn < c0 || row.startColumn > c1) continue
    drawHomeBadge(ctx, scene, nodeX(row.startColumn), nodeY(row.index), 'center')
  }
}

/** "You are here": a small accent house pinned to the home changeset's
 *  shoulder. A badge, not a ring — the outer accent ring means "selected",
 *  and the two states must never look alike. It behaves like a map pin:
 *  drawn in SCREEN space with a size floor, so it stays findable zoomed far
 *  out (exactly when "where is home?" matters most) and never balloons
 *  zoomed in. */
function drawHomeBadge(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  x: number,
  y: number,
  /** 'shoulder' pins to a node's top-right (the default, over an avatar);
   *  'center' sits on the point itself — empty lanes have no avatar to yield
   *  to, and their shoulder spot collides with the label pill above. */
  anchor: 'shoulder' | 'center' = 'shoulder'
): void {
  const { view, dpr, palette } = scene
  // Tracks the zoom: grows with the nodes when zoomed in, clamped on both
  // ends so it stays findable yet never balloons.
  const r = Math.min(13, Math.max(4, 8 * view.scale))
  const nodeScreenR = NODE_R * view.scale
  // Once the badge would outgrow the node it marks, the metaphor breaks (an
  // empty ring dwarfing a 5px node reads as a glitch). Below that point the
  // marker BECOMES the node: a solid accent dot in its place — avatars are
  // an unreadable blur at these zooms, and a filled dot in the home spot is
  // exactly how a map marks "you are here" at country scale.
  if (r >= nodeScreenR) {
    const cx = x * view.scale + view.x
    const cy = y * view.scale + view.y
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(3, nodeScreenR + 1.5), 0, Math.PI * 2)
    ctx.fillStyle = palette.accent
    ctx.fill()
    // Hairline background rim so the dot separates from the branch spine.
    ctx.lineWidth = 1
    ctx.strokeStyle = palette.bg
    ctx.stroke()
    ctx.restore()
    return
  }
  // Anchored to the node's top-right shoulder; as the node shrinks the badge
  // converges onto it, pin-style. Snapped to the half-device-pixel grid: the
  // glyph is mirror-symmetric, but antialiasing renders it symmetric only
  // when its axis lands on the grid — measured: a 0.3px fractional anchor
  // skews mirrored pixel coverage by up to ~33% (a lopsided roof), while
  // 0 and 0.5 offsets rasterize exactly.
  const snap = (v: number) => Math.round(v * dpr * 2) / (dpr * 2)
  const off = anchor === 'shoulder' ? NODE_R * view.scale * 0.8 : 0
  const sx = snap(x * view.scale + view.x + off)
  const sy = snap(y * view.scale + view.y - off)
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // Below this the house is antialiasing soup: a solid accent mini-pin on
  // the shoulder instead — filled, never a hollow ring, which reads broken.
  if (r < 5.5) {
    ctx.beginPath()
    ctx.arc(sx, sy, r * 0.8, 0, Math.PI * 2)
    ctx.fillStyle = palette.accent
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = palette.bg
    ctx.stroke()
    ctx.restore()
    return
  }
  // Plastic-style badge: a LIGHT disc with an accent ring and an accent
  // glyph. Dark-on-light stays crisp at badge sizes where a light glyph on
  // a solid accent disc turns to mush.
  ctx.beginPath()
  ctx.arc(sx, sy, r, 0, Math.PI * 2)
  ctx.fillStyle = palette.labelBg
  ctx.fill()
  ctx.lineWidth = Math.max(1, r * 0.2)
  ctx.strokeStyle = palette.accent
  ctx.stroke()
  // The home glyph — the SAME single-outline house as Icon.Home in
  // lib/icons.tsx (walls, roof, door notched into the bottom edge),
  // recentered and scaled so the house spans about the disc's radius —
  // badge glyphs need more surrounding air than a bare toolbar icon.
  // Keep the two in sync: one symbol, two sizes.
  const s = r / 13
  ctx.strokeStyle = palette.accent
  ctx.lineWidth = Math.max(1.1, 1.7 * s)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(sx - 6.5 * s, sy + 6.5 * s)
  ctx.lineTo(sx - 6.5 * s, sy - 2 * s)
  ctx.lineTo(sx, sy - 6.5 * s)
  ctx.lineTo(sx + 6.5 * s, sy - 2 * s)
  ctx.lineTo(sx + 6.5 * s, sy + 6.5 * s)
  ctx.lineTo(sx + 1.7 * s, sy + 6.5 * s)
  ctx.lineTo(sx + 1.7 * s, sy + 2.8 * s)
  ctx.lineTo(sx - 1.7 * s, sy + 2.8 * s)
  ctx.lineTo(sx - 1.7 * s, sy + 6.5 * s)
  ctx.closePath()
  ctx.stroke()
  ctx.restore()
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
  maxWorldWidth: number,
  maxScreenCap = CAPTION_MAX_SCREEN_W
): number {
  const { view, dpr, palette } = scene
  // All-or-nothing (see geometry.ts): the whole layer fades below the zoom
  // where the tightest slot goes unreadable — never caption by caption.
  const reveal = captionAlpha(view.scale)
  if (reveal === 0) return 0
  const startX = worldX * view.scale + view.x
  // Bounded by the slot, the style cap AND the viewport's right edge: a
  // caption reaching the edge truncates with an ellipsis there — the canvas
  // must never clip glyphs mid-stroke. Panning left re-truncates and the
  // text progressively reveals itself.
  const maxScreenWidth = Math.min(
    maxWorldWidth * view.scale,
    maxScreenCap,
    scene.width - startX - 8
  )
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
    ctx.fillText(fitted, startX, y)
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
  // The home changeset skips the cosmetic 3.4-column cap and gets a roomier
  // screen cap: its subject is the one users look for most, and truncating it
  // beside empty canvas reads as a bug. Real neighbors still bound it (gap).
  const slot = gap * COL_W - CAPTION_SLOT_AIR
  const maxWidth = node.isHead ? slot : Math.min(slot, COL_W * 3.4)
  captionWidths.set(
    node.commit.hash,
    drawCaption(
      ctx,
      scene,
      node.commit.subject,
      x - NODE_R,
      y,
      maxWidth,
      node.isHead ? CAPTION_HOME_MAX_SCREEN_W : CAPTION_MAX_SCREEN_W
    )
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
    // A tag-name hit is the CHIP itself, in the same gold find treatment the
    // branch labels wear: the chip stays at full strength (its commit didn't
    // match — the tag did, so the node beneath keeps its dim), glow behind,
    // gold border, and corona + ping when current.
    const isHitTag = scene.hitTags?.has(node.commit.hash) === true
    const isActiveTag =
      scene.activeHit?.kind === 'tag' && scene.activeHit.hash === node.commit.hash
    if (isHitTag) ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.roundRect(chip.x, chip.y, chip.w, chip.h, 4)
    if (isHitTag) {
      ctx.save()
      ctx.shadowColor = withAlpha(palette.match, isActiveTag ? 0.95 : 0.65)
      ctx.shadowBlur = isActiveTag ? 12 : 8
      ctx.fillStyle = palette.labelBg
      ctx.fill()
      ctx.restore()
    }
    ctx.fillStyle = palette.labelBg
    ctx.fill()
    ctx.strokeStyle = isHitTag ? palette.match : palette.tag
    ctx.lineWidth = 1
    if (!isHitTag) ctx.globalAlpha *= 0.8
    ctx.stroke()
    ctx.globalAlpha = isHitTag ? 1 : dimmed(scene, node.commit.hash) ? DIM_ALPHA : 1
    ctx.fillStyle = palette.tag
    ctx.fillText(label, x, chip.y + 8)
    if (isActiveTag) {
      drawRectPing(ctx, scene, chip, 4)
      ctx.globalAlpha = 1
    }
  }
}

function drawWip(ctx: CanvasRenderingContext2D, scene: SceneState): void {
  const { palette } = scene
  if (!scene.wip) return
  const { column, row, count, color } = scene.wip
  // The WIP node is never a hit (it isn't a commit), so while a filter or
  // search dims the diagram it recedes with the non-matches — a full-strength
  // "uncommitted" beside dimmed commits would read as a result.
  const dim = scene.matches !== null
  const x = nodeX(column)
  const y = nodeY(row)
  const tipX = nodeX(column - 1)
  ctx.strokeStyle = branchStroke(palette, color)
  ctx.setLineDash([3, 3])
  ctx.lineWidth = 1.5
  ctx.globalAlpha = dim ? DIM_ALPHA : 0.9
  ctx.beginPath()
  ctx.moveTo(tipX + NODE_R, y)
  ctx.lineTo(x - NODE_R, y)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y, NODE_R, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = dim ? DIM_ALPHA : 1
  ctx.fillStyle = palette.subject
  ctx.font = `600 10px ${palette.font}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 99 ? '99+' : `+${count}`, x, y + 0.5)
  // Placed exactly like a commit's caption — same size, weight, capsule gap
  // and left edge — so the WIP node reads as one more entry in the chain.
  // drawCaption multiplies the current alpha, so the dim carries through.
  drawCaption(ctx, scene, 'uncommitted', x - NODE_R, y, COL_W * 3.4)
  ctx.globalAlpha = 1
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  labelBoxes: LabelBox[],
  /** Chains holding at least one match, or null when nothing is filtering. */
  lit: ReadonlySet<number> | null
): void {
  const { palette } = scene
  ctx.font = `600 ${LABEL_FONT}px ${palette.font}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  for (const { row, rect, sticky } of labelBoxes) {
    const head = row.isHead
    // While a filter/search dims commits, labels of hitless branches ghost
    // with them — a full-strength label over dimmed commits would claim a
    // hit the branch doesn't have. (Empty branches have no nodes, so they
    // ghost too: a zero-commit branch can never hold a match.)
    const ghost = lit !== null && !lit.has(row.chain)
    // A branch-name hit is the LABEL itself: the same gold find treatment
    // commits get, pill-shaped — glow behind it, and for the current hit a
    // corona ring plus the arrival ping (below). litChains keeps hit labels
    // out of the ghost set, so a hit always draws at full strength.
    const isHitLabel = scene.hitBranches?.has(row.chain) === true
    const isActiveHit = scene.activeHit?.kind === 'branch' && scene.activeHit.chain === row.chain
    const inkAlpha = ghost ? LABEL_GHOST_ALPHA : row.kind === 'unnamed' ? 0.8 : 1
    // The opaque base NEVER ghosts: a translucent pill lets the capsule and
    // spine bleed through the text and reads as a glitch. Ghosting fades the
    // pill's ink — tint, border, name — while the body keeps masking the
    // diagram behind it.
    ctx.globalAlpha = row.kind === 'unnamed' ? 0.8 : 1
    ctx.beginPath()
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 5)
    // A sticky pill floats over diagram content — a soft shadow makes the
    // layering read as deliberate. A hit's gold bloom replaces it: a shadow,
    // not a radial gradient — it hugs the rounded shape.
    if (isHitLabel || sticky) {
      ctx.save()
      if (isHitLabel) {
        ctx.shadowColor = withAlpha(palette.match, isActiveHit ? 0.95 : 0.65)
        ctx.shadowBlur = isActiveHit ? 14 : 9
      } else {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'
        ctx.shadowBlur = 6
        ctx.shadowOffsetY = 1
      }
      ctx.fillStyle = palette.labelBg
      ctx.fill()
      ctx.restore()
    } else {
      // Opaque base so day lines never bleed through the tinted pill.
      ctx.fillStyle = palette.labelBg
      ctx.fill()
    }
    ctx.globalAlpha = inkAlpha
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
    if (isActiveHit) drawRectPing(ctx, scene, rect, 5)
    ctx.globalAlpha = 1
  }
}

/** The current hit's corona + arrival ping around a pill/chip rect — the
 *  rectangular twin of the node treatment in drawNodes, shared by branch
 *  labels and tag chips. */
function drawRectPing(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  rect: { x: number; y: number; w: number; h: number },
  radius: number
): void {
  ctx.strokeStyle = scene.palette.match
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.roundRect(rect.x - 2.5, rect.y - 2.5, rect.w + 5, rect.h + 5, radius + 2)
  ctx.stroke()
  for (const ring of pingRings(scene.matchPulse)) {
    ctx.globalAlpha = ring.alpha
    ctx.lineWidth = ring.width
    const grow = 2.5 + ring.grow
    ctx.beginPath()
    ctx.roundRect(rect.x - grow, rect.y - grow, rect.w + 2 * grow, rect.h + 2 * grow, radius + grow)
    ctx.stroke()
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
      i + 1 < marks.length ? (nodeX(marks[i + 1].column) - COL_W / 2) * view.scale + view.x : width
    if (next < 6 || x > width) continue
    if (x >= 0) {
      ctx.strokeStyle = palette.headerLine
      ctx.beginPath()
      ctx.moveTo(x + 0.5, 4)
      ctx.lineTo(x + 0.5, HEADER_H - 4)
      ctx.stroke()
    }
    // Center the label in its day segment's currently-visible span so it stays
    // readable mid-pan (the sticky effect): as the segment scrolls past the left
    // edge the label recenters in the space that's left. But it must never spill
    // past the segment's right boundary onto the next day's label — so we clamp
    // it left, repositioning as far as we can until it sits right-aligned against
    // the boundary (with a small margin). If even that won't fit, the label clips
    // on the left instead of ellipsizing — the date is cut but never mangled.
    const label = marks[i].label
    const labelW = ctx.measureText(label).width
    const visibleLeft = Math.max(x, 0)
    const visibleRight = Math.min(next, width)
    let labelX = (visibleLeft + visibleRight) / 2 - labelW / 2
    labelX = Math.max(labelX, visibleLeft)
    // Right boundary wins over the left clamp: keep the date off the next day.
    labelX = Math.min(labelX, next - HEADER_LABEL_PAD - labelW)
    ctx.save()
    ctx.beginPath()
    ctx.rect(visibleLeft, 0, Math.max(0, visibleRight - visibleLeft), HEADER_H)
    ctx.clip()
    ctx.fillText(label, labelX, HEADER_H / 2 + 0.5)
    ctx.restore()
  }
}
