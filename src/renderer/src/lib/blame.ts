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

/**
 * Vertical offset (px) applied to the whole metadata gutter and the section
 * rules so they line up with Pierre's source rows.
 *
 * Pierre insets its first source line below the top of its scroll container:
 * `DEFAULT_CODE_VIEW_LAYOUT` adds `paddingTop: 8` (a `margin-top` on the code
 * container) plus the sticky container's `gap: 8` above the first item — 16px
 * total. Our gutter is a separate column that starts flush at the body top, so
 * without compensation every row sits one line + 4px high. (The mismatch reads
 * as "only the first row is off" because an interior label landing a line high
 * hides inside its commit's band, while the first label floats alone in the
 * empty space above line 1 — but measuring shows the whole gutter is shifted.)
 *
 * Folding this into the two scroll-synced content layers — rather than nudging
 * each cell, age stripe, and rule — keeps the label, the heat stripe, and the
 * boundary hairlines all locked to the code from one place. Verified row-for-row
 * against Pierre's rendered line rects (label centers land dead-on the code).
 */
export const BLAME_GUTTER_OFFSET = 16

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

// ── Age heat: the gutter stripe + legend that show how old each line is ──────

/**
 * Map a normalized line age (0 = oldest in the file, 1 = newest) to a heat
 * color — older reads pale, newer reads warm and saturated. Used by both the
 * per-line gutter stripe and the header legend so they share one scale.
 */
export function ageColor(t: number): string {
  const c = Math.max(0, Math.min(1, t))
  const saturation = Math.round(35 + c * 50)
  const lightness = Math.round(86 - c * 40)
  return `hsl(28 ${saturation}% ${lightness}%)`
}

/** Evenly spaced age colors (old → new) for the legend swatches. */
export function ageScale(steps = 7): string[] {
  return Array.from({ length: steps }, (_, i) => ageColor(steps <= 1 ? 1 : i / (steps - 1)))
}

/**
 * Fraction of a timestamp within `[min, max]`, clamped to [0,1]. Returns 1 when
 * the range is empty (single commit) or the time is unknown, so such lines read
 * as "newest" rather than colorless.
 */
export function ageFraction(ms: number, min: number, max: number): number {
  if (!Number.isFinite(ms) || max <= min) return 1
  return Math.max(0, Math.min(1, (ms - min) / (max - min)))
}

/** Min/max author timestamps (ms) across blame lines — the file's age span. */
export function ageRange(lines: BlameLine[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const line of lines) {
    const ms = Date.parse(line.date)
    if (!Number.isFinite(ms)) continue
    if (ms < min) min = ms
    if (ms > max) max = ms
  }
  return { min, max }
}
