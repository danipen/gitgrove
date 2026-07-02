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
  | { type: 'wip' }

/**
 * What sits at a world point: a commit node, a branch label, or the WIP node.
 * Nodes win over labels (they're the smaller target).
 */
export function hitTest(
  layout: GraphLayout,
  wx: number,
  wy: number,
  labelWidth: (row: GraphRow) => number,
  wipColumn: number | null,
  headRow: number,
  /** The sticky-label clamp the renderer used this frame (world x). */
  labelLeftClampX = Number.NEGATIVE_INFINITY
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
