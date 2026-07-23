// The middle-trim maths behind TrimmedPath.tsx: cut a path's directory prefix
// so the rendered "prefix…" + basename exactly fills the available width. Pure
// — the caller injects the text measurer — so the cut is testable without a
// DOM.

export const ELLIPSIS = '…'

/**
 * The longest prefix of `dir` that, followed by the ellipsis, fits in
 * `maxWidth`: `dir` untouched when the whole thing already fits, '' when not
 * even the bare ellipsis does. `measure` maps text to its rendered width and
 * must grow with its input. The search bisects over code points, so surrogate
 * pairs (an emoji in a folder name) are never cut in half.
 */
export function trimDirToFit(
  dir: string,
  maxWidth: number,
  measure: (text: string) => number
): string {
  if (measure(dir) <= maxWidth) return dir
  if (measure(ELLIPSIS) > maxWidth) return ''
  const chars = Array.from(dir)
  // Invariant: prefix of length `lo` fits (with the ellipsis), `hi` doesn't —
  // `hi` starts at the full length, which the check above proved too wide.
  let lo = 0
  let hi = chars.length
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (measure(chars.slice(0, mid).join('') + ELLIPSIS) <= maxWidth) lo = mid
    else hi = mid
  }
  return chars.slice(0, lo).join('') + ELLIPSIS
}
