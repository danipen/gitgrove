// Pure logic for the Blame pane: the synced-gutter virtualization window, the
// "can this line be reblamed?" predicate, and the reblame navigation stack.
// Kept free of React/DOM so it can be unit-tested directly (see blame.test.ts).

import type { BlameLine } from '@shared/types'

/**
 * Code line height (px). Pinned via `--diffs-line-height` on the overlay so
 * Pierre's source lines and our separate metadata gutter share one row height
 * and stay aligned at any scroll position. Keep in sync with `.file-history`
 * in styles/features/blame.css.
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

/** A run of consecutive lines from one commit, with the line carrying its label. */
export interface BlameRun {
  /** First line index in the run. */
  start: number
  /** Exclusive end — the next run's start, or `lines.length` for the last run. */
  end: number
  /** The run-start line, whose author/message/date label the band. */
  line: BlameLine
}

/**
 * Collapse the per-line blame into its runs (one entry per labelled band).
 * Computed once when blame loads so the sticky-header lookup is a binary search
 * rather than an O(run) walk on every scroll frame.
 */
export function blameRuns(lines: BlameLine[]): BlameRun[] {
  const runs: BlameRun[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isRunStart(lines, i)) runs.push({ start: i, end: lines.length, line: lines[i] })
  }
  for (let r = 0; r < runs.length - 1; r++) runs[r].end = runs[r + 1].start
  return runs
}

/** The run containing `lineIndex`, or null if out of range (binary search). */
export function runAt(runs: BlameRun[], lineIndex: number): BlameRun | null {
  let lo = 0
  let hi = runs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const run = runs[mid]
    if (lineIndex < run.start) hi = mid - 1
    else if (lineIndex >= run.end) lo = mid + 1
    else return run
  }
  return null
}

/** A run pinned to the gutter top, with its current top offset (gutter px). */
export interface BlameSticky {
  run: BlameRun
  /** Top offset within the gutter viewport: 0 when pinned, negative once the
   *  next run's start pushes it up; never positive (it hugs the top edge). */
  top: number
}

/**
 * The block header to float at the gutter's top edge for the current scroll, so
 * a tall block keeps its author/message/date in view instead of a blank band.
 * Returns null while the active block's own first line is still on screen (the
 * normal run-start cell already shows the label there) or at the very top.
 *
 * The header pins at `top: 0` until the *next* block's first line reaches the
 * top, then rides up with it — clamped to one line above that line — so the two
 * never overlap and the handoff reads as one header pushing out the last.
 *
 * Single-line blocks are skipped: their header would be in the pushed-up state
 * the instant it appeared (the next block's line is right below it), so it would
 * only flicker on the way past — nothing is ever hidden worth pinning.
 */
export function stickyRun(
  runs: BlameRun[],
  scrollTop: number,
  lineHeight = BLAME_LINE_HEIGHT
): BlameSticky | null {
  if (runs.length === 0 || scrollTop <= 0) return null
  const run = runAt(runs, Math.floor(scrollTop / lineHeight))
  if (!run || run.end - run.start <= 1 || scrollTop <= run.start * lineHeight) return null
  const pushedUp = (run.end - 1) * lineHeight - scrollTop
  return { run, top: Math.min(0, pushedUp) }
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
