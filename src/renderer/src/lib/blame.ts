// Pure logic for the Blame pane: the synced-gutter virtualization window, the
// "can this line be reblamed?" predicate, and the reblame navigation stack.
// Kept free of React/DOM so it can be unit-tested directly (see blame.test.ts).

import type { BlameLine } from '@shared/types'

/**
 * Code line height (px). Pinned via `--diffs-line-height` on the overlay so
 * Pierre's source lines and our separate metadata gutter share one row height
 * and stay aligned at any scroll position. Keep in sync with `.file-history`
 * in global.css.
 */
export const BLAME_LINE_HEIGHT = 20

/** Half-open row window `[start, end)` to render in the gutter. */
export interface BlameWindow {
  start: number
  end: number
}

/**
 * The slice of gutter rows worth rendering for the current synced scroll
 * position — mirrors the windowing the source editor does internally, so a
 * huge file keeps only a few dozen gutter nodes alive. `overscan` rows above
 * and below absorb sub-pixel rounding during a fling.
 */
export function blameWindow(
  scrollTop: number,
  viewportH: number,
  count: number,
  overscan = 6,
  lineHeight = BLAME_LINE_HEIGHT
): BlameWindow {
  if (count <= 0 || viewportH <= 0) return { start: 0, end: 0 }
  const start = Math.max(0, Math.floor(scrollTop / lineHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + viewportH) / lineHeight) + overscan)
  return { start, end: Math.max(start, end) }
}

/**
 * True when a line starts a new run of consecutive lines from the same commit.
 * The gutter shows commit metadata only on run starts (the GitLens / Plastic
 * "Annotate" look), so a block edited in one commit reads as one labelled band.
 */
export function isRunStart(lines: BlameLine[], index: number): boolean {
  if (index <= 0) return true
  return lines[index - 1].hash !== lines[index].hash
}

/**
 * A line can be reblamed only when git gave us a prior version to walk back to
 * (`previous`) and it isn't an uncommitted working-tree line. Root commits and
 * walk boundaries have no `previous`, so they're naturally excluded.
 */
export function canReblame(line: BlameLine): boolean {
  return !line.notCommitted && line.previous != null
}

/** One step of reblame history: which revision/path the gutter is showing. */
export interface BlameFrame {
  /** Revision to blame, or null for the working tree. */
  ref: string | null
  /** The file's path at that revision (rename-correct). */
  path: string
  /** Compact breadcrumb label ("working tree" or a short sha). */
  label: string
}

/**
 * Push the reblame target for `line` — its parent revision and the file's path
 * there — onto the stack. A no-op for lines that can't be reblamed.
 */
export function pushReblame(stack: BlameFrame[], line: BlameLine): BlameFrame[] {
  if (!canReblame(line) || line.previous == null) return stack
  return [
    ...stack,
    { ref: line.previous.hash, path: line.previous.filename, label: line.previous.hash.slice(0, 7) }
  ]
}

/** Pop back one reblame step; the initial frame is never removed. */
export function popReblame(stack: BlameFrame[]): BlameFrame[] {
  return stack.length > 1 ? stack.slice(0, -1) : stack
}
