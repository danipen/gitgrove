// Geometry for the Graph canvas: world-space metrics, the pan/zoom transform,
// content bounds, hit-testing and keyboard-neighbor navigation. Pure module —
// the canvas component and the renderer both build on it, and the navigation
// logic is unit-testable without a canvas.

import type { GraphLayout, GraphNode, GraphRow } from './layout'

// World-space metrics (scaled by the view's zoom when drawn).
export const COL_W = 44
// Row pitch leaves clear air between a node's subject text (below the node)
// and the next row's label band — they must never touch (see render.ts).
export const ROW_H = 72
export const NODE_R = 12
/** Left/right padding before the first and after the last column. */
export const MARGIN_X = 28
/** Space above row 0 — the date header strip is drawn over this band. */
export const MARGIN_Y = 34
/** Screen-space height of the sticky date header. */
export const HEADER_H = 26
/** Branch label pill: height and its gap above the row spine. */
export const LABEL_H = 18
export const LABEL_GAP = 4
/** Branch container capsule: horizontal padding past the outer nodes, and
 *  half its height. Shared by the renderer and hit-testing — the capsule is
 *  itself a click target (it IS the branch). */
export const CAPSULE_PAD = 10
export const CAPSULE_HALF_H = 19
/** Caption line under a node (subject text). The capsule edge is world-space
 *  but caption glyphs are screen-fixed (render.ts SUBJECT_FONT), so the gap
 *  between them must be screen-fixed too — a world-space anchor sinks the
 *  text into the capsule when zooming out and floats it far below when
 *  zooming in. SCREEN px from the capsule's bottom edge down to the text
 *  line's CENTER when the corridor is roomy: 13px type spans ~5px of ink
 *  above its center, so 11 leaves ~6px of clear air under the capsule. */
export const CAPTION_GAP_SCREEN = 11
/** SCREEN height of the caption's hit band (13px type plus slop). */
export const CAPTION_BAND_H = 21
/** Approximate SCREEN ink extents of a caption line around its middle
 *  baseline: cap height above, baseline and descenders below. Sized for the
 *  13px caption type (render.ts SUBJECT_FONT); they drive the squeeze math
 *  in captionCenterOffset. */
export const CAPTION_INK_ABOVE = 5
export const CAPTION_INK_BELOW = 6.5
/** Horizontal air a caption leaves before the next node's slot begins. */
export const CAPTION_SLOT_AIR = 10
/** Caption width bounds in SCREEN px — captions draw at a fixed screen size
 *  (render.ts SUBJECT_FONT), so their width is screen-bounded too:
 *  - MIN (a handful of characters): the least a caption can show and still
 *    mean something.
 *  - MAX (~a 3.4-column slot at zoom 1): past it a caption would sprawl over
 *    the empty canvas where edges run, instead of staying by its node. */
export const CAPTION_MIN_SCREEN_W = 34
export const CAPTION_MAX_SCREEN_W = 160
/** The home changeset ("you are here") earns a fuller caption: its subject is
 *  the one users look for most, so its cap is roomier — still bounded by real
 *  neighbors (the gap to the next node, the WIP node), never cosmetic. */
export const CAPTION_HOME_MAX_SCREEN_W = 260
/** Captions are ALL-OR-NOTHING across the graph: the layer is fully on at the
 *  zoom where the TIGHTEST standard slot — two adjacent commits, one column
 *  apart — reaches CAPTION_MIN_SCREEN_W (zoom 1, by construction), and fades
 *  out as a whole just below it. Per-node culling made captions vanish one by
 *  one while zooming out, which read as random. */
export const CAPTION_FULL_ZOOM = CAPTION_MIN_SCREEN_W / (COL_W - CAPTION_SLOT_AIR)
/** Zoom span under CAPTION_FULL_ZOOM over which the layer fades — a soft exit
 *  instead of a hard pop while zooming through the threshold. */
const CAPTION_FADE_SPAN = 0.15

/** Caption layer opacity at a zoom level; 0 = hidden (hit-testing follows). */
export function captionAlpha(scale: number): number {
  const t = (scale - (CAPTION_FULL_ZOOM - CAPTION_FADE_SPAN)) / CAPTION_FADE_SPAN
  return Math.min(1, Math.max(0, t))
}

/** Columns until the next node on the same row (∞-ish at the row tip). */
export function columnsToNext(layout: GraphLayout, node: GraphNode): number {
  let best = 6
  for (const n of layout.nodes) {
    if (n.row !== node.row || n.column <= node.column) continue
    best = Math.min(best, n.column - node.column)
  }
  return best
}

/** World width of a node's caption area (mirrors the renderer's truncation). */
export function captionWidth(layout: GraphLayout, node: GraphNode): number {
  return Math.min(columnsToNext(layout, node) * COL_W - CAPTION_SLOT_AIR, COL_W * 3.4)
}

/** WORLD offset from a row's center down to its caption line's center at a
 *  zoom level. Shared by the renderer, the hover-card anchor and hit-testing.
 *
 *  The caption lives in a corridor between two world-space rails: its own
 *  capsule's bottom edge above, and the next row's label band below. When the
 *  corridor is roomy the caption hugs the capsule with the design gap; when
 *  zooming out squeezes the corridor, the remaining slack is split evenly so
 *  the text keeps equal air on both sides instead of invading the labels. */
export function captionCenterOffset(scale: number): number {
  const railBottom = ROW_H - NODE_R - LABEL_GAP - LABEL_H
  const corridor = (railBottom - CAPSULE_HALF_H) * scale
  const slack = corridor - CAPTION_INK_ABOVE - CAPTION_INK_BELOW
  const air = Math.max(1, Math.min(CAPTION_GAP_SCREEN - CAPTION_INK_ABOVE, slack / 2))
  return CAPSULE_HALF_H + (air + CAPTION_INK_ABOVE) / scale
}

/** Pan/zoom: screen = world * scale + offset. */
export interface View {
  x: number
  y: number
  scale: number
}

export const MIN_SCALE = 0.2
export const MAX_SCALE = 3

export const nodeX = (column: number): number => MARGIN_X + column * COL_W + COL_W / 2
export const nodeY = (row: number): number => MARGIN_Y + row * ROW_H + ROW_H / 2

export const toWorldX = (view: View, screenX: number): number => (screenX - view.x) / view.scale
export const toWorldY = (view: View, screenY: number): number => (screenY - view.y) / view.scale

/** World-space size of the whole diagram (an extra column when a WIP node shows). */
export function contentSize(layout: GraphLayout, wip: boolean): { width: number; height: number } {
  const columns = layout.columnCount + (wip ? 1 : 0)
  return {
    width: MARGIN_X * 2 + Math.max(1, columns) * COL_W,
    height: MARGIN_Y + Math.max(1, layout.rowCount) * ROW_H + ROW_H / 2
  }
}

/**
 * Branch label pill rect in world space; text width is measured by the caller.
 * `leftClampX` makes the label sticky: while the row extends past the left
 * viewport edge, the pill slides right to stay readable — but never past the
 * row's end, so it "parks" as the branch scrolls away.
 */
export function labelRect(
  row: GraphRow,
  textWidth: number,
  leftClampX = Number.NEGATIVE_INFINITY
): { x: number; y: number; w: number; h: number } {
  const w = textWidth + 16
  const restX = nodeX(row.startColumn) - NODE_R
  const maxX = Math.max(restX, nodeX(row.endColumn) + NODE_R - w)
  return {
    x: Math.min(Math.max(restX, leftClampX), maxX),
    y: nodeY(row.index) - NODE_R - LABEL_GAP - LABEL_H,
    w,
    h: LABEL_H
  }
}

export type GraphHit =
  | { type: 'node'; node: GraphNode }
  | { type: 'label'; row: GraphRow }
  /** The branch container capsule — selects the branch, like its label. */
  | { type: 'row'; row: GraphRow }
  | { type: 'wip' }

/**
 * What sits at a world point: a commit node, a branch label, the branch's
 * container capsule, or the WIP node — checked smallest target first.
 */
export function hitTest(
  layout: GraphLayout,
  wx: number,
  wy: number,
  labelWidth: (row: GraphRow) => number,
  wipColumn: number | null,
  headRow: number,
  /** The sticky-label clamp the renderer used this frame (world x). */
  labelLeftClampX = Number.NEGATIVE_INFINITY,
  /** Whether captions are drawn at the current zoom (they hit-test too). */
  captions = true,
  /** World width a node's caption actually DREW this frame (the renderer
   *  measures and caches it — render.ts captionWidthFor); 0 when culled,
   *  undefined before the first draw (falls back to the slot estimate).
   *  Keeps the hover target on the glyphs themselves: the empty tail of a
   *  wide slot must not pop the message card while the mouse crosses lines. */
  drawnCaptionWidth?: (node: GraphNode) => number | undefined,
  /** The view's zoom — captions anchor a screen-fixed gap below the capsule,
   *  so their world-space hit band depends on it (captionCenterOffset). */
  scale = 1
): GraphHit | null {
  const slop = 4
  const row = Math.floor((wy - MARGIN_Y) / ROW_H)
  // Only the point's own column (±1 for the slop) and row can contain a node.
  const column = Math.round((wx - MARGIN_X - COL_W / 2) / COL_W)
  for (const node of layout.nodes) {
    if (Math.abs(node.column - column) > 1 || node.row !== row) continue
    const dx = wx - nodeX(node.column)
    const dy = wy - nodeY(node.row)
    if (dx * dx + dy * dy <= (NODE_R + slop) ** 2) return { type: 'node', node }
  }
  if (wipColumn !== null && row === headRow) {
    const dx = wx - nodeX(wipColumn)
    const dy = wy - nodeY(headRow)
    if (dx * dx + dy * dy <= (NODE_R + slop) ** 2) return { type: 'wip' }
  }
  for (const r of layout.rows) {
    const rect = labelRect(r, labelWidth(r), labelLeftClampX)
    if (wx >= rect.x && wx <= rect.x + rect.w && wy >= rect.y && wy <= rect.y + rect.h) {
      return { type: 'label', row: r }
    }
  }
  // A node's caption acts as the node: hovering it expands the message,
  // clicking it selects the commit. Overlapping bands (dense lanes) resolve
  // to the caption that starts closest to the pointer.
  if (captions) {
    let best: GraphNode | null = null
    const bandHalf = CAPTION_BAND_H / 2 / scale
    for (const node of layout.nodes) {
      const center = nodeY(node.row) + captionCenterOffset(scale)
      if (wy < center - bandHalf || wy > center + bandHalf) continue
      const width = drawnCaptionWidth?.(node) ?? captionWidth(layout, node)
      if (width <= 0) continue
      const x0 = nodeX(node.column) - NODE_R
      if (wx < x0 || wx > x0 + width) continue
      if (!best || node.column > best.column) best = node
    }
    if (best) return { type: 'node', node: best }
  }
  for (const r of layout.rows) {
    if (Math.abs(wy - nodeY(r.index)) > CAPSULE_HALF_H) continue
    // The HEAD row's capsule stretches to embrace the WIP node (see render.ts).
    const endColumn = r.isHead && wipColumn !== null ? wipColumn : r.endColumn
    const x0 = nodeX(r.startColumn) - NODE_R - CAPSULE_PAD
    const x1 = nodeX(endColumn) + NODE_R + CAPSULE_PAD
    if (wx >= x0 && wx <= x1) return { type: 'row', row: r }
  }
  return null
}

/**
 * Keyboard navigation target from `node`: left/right walk the same row (older/
 * newer), up/down jump to the column-nearest node one row away.
 */
export function neighborNode(
  layout: GraphLayout,
  node: GraphNode,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
): GraphNode | null {
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const dir = key === 'ArrowLeft' ? -1 : 1
    let best: GraphNode | null = null
    for (const n of layout.nodes) {
      if (n.row !== node.row || Math.sign(n.column - node.column) !== dir) continue
      if (!best || Math.abs(n.column - node.column) < Math.abs(best.column - node.column)) best = n
    }
    return best
  }
  const targetRow = node.row + (key === 'ArrowUp' ? -1 : 1)
  let best: GraphNode | null = null
  for (const n of layout.nodes) {
    if (n.row !== targetRow) continue
    if (!best || Math.abs(n.column - node.column) < Math.abs(best.column - node.column)) best = n
  }
  return best
}
