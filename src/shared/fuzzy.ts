// Fuzzy matching for the command palette: "does every query character appear,
// in order, somewhere in the text — and how good a match is it?". Shared by
// the main process (the repo's file index, up to hundreds of thousands of
// paths per keystroke) and the renderer (commands, refs, stashes), so the two
// rank and highlight identically.
//
// The algorithm is fzf's v1: a forward scan finds the first place the whole
// query fits, a backward scan from there tightens the window to the shortest
// tail, and a scoring pass over that window rewards matches on word
// boundaries (after `/`, `-`, `_`, `.`, a space, or a camelCase hump) and
// consecutive runs while penalizing gaps. Linear in the text length and
// allocation-free unless match positions are asked for — what keeps a
// single-letter query over a 500k-path repo within a frame budget.

const SCORE_MATCH = 16
const GAP_START = -3
const GAP_EXTENSION = -1
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 7
const BONUS_CONSECUTIVE = 5
const FIRST_CHAR_MULTIPLIER = 2
/** Matching inside a path's file name beats matching across its directories:
 *  `graph` should rank `GraphView.tsx` above `graphics/old/view.ts`. */
const BONUS_BASENAME = 40

export interface FuzzyMatch {
  score: number
  /** Indexes into the text of each matched character, ascending. */
  positions: number[]
}

/**
 * Lowercase `text` without changing its length, so indexes into the folded
 * copy are indexes into the original. `toLowerCase` can expand a few code
 * points (`İ` → `i̇`); those fall back to a per-unit fold.
 */
export function foldCase(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ''
  for (const unit of text) out += unit.toLowerCase().slice(0, unit.length).padEnd(unit.length)
  return out
}

/** The query as the matcher wants it: case-folded, whitespace ignored. */
export function normalizeQuery(query: string): string {
  return foldCase(query.replace(/\s+/g, ''))
}

const isSeparator = (c: string) =>
  c === '/' || c === '\\' || c === '-' || c === '_' || c === '.' || c === ' ' || c === ':'
const isLower = (c: string) => c >= 'a' && c <= 'z'
const isUpper = (c: string) => c >= 'A' && c <= 'Z'

/** How much a match at `i` is worth beyond the base score: word starts win. */
function boundaryBonus(text: string, i: number): number {
  if (i === 0) return BONUS_BOUNDARY
  const prev = text[i - 1]
  if (isSeparator(prev)) return BONUS_BOUNDARY
  if (isLower(prev) && isUpper(text[i])) return BONUS_CAMEL
  return 0
}

/**
 * Score `query` (normalized) against `text` (with its `folded` twin), or null
 * when it doesn't match. When `positions` is given, the matched indexes are
 * appended to it.
 */
function scoreWindow(
  query: string,
  text: string,
  folded: string,
  positions: number[] | null
): number | null {
  if (query.length === 0) return 0
  if (query.length > folded.length) return null

  // Forward: the earliest index at which the whole query has been seen.
  let qi = 0
  let end = -1
  for (let i = 0; i < folded.length; i++) {
    if (folded[i] === query[qi] && ++qi === query.length) {
      end = i
      break
    }
  }
  if (end < 0) return null

  // Backward from there: the latest start that still fits the query, which
  // trims a leading false start ("a…a…b" matching "ab" starts at the 2nd a).
  let start = end
  qi = query.length - 1
  for (let i = end; i >= 0; i--) {
    if (folded[i] === query[qi] && --qi < 0) {
      start = i
      break
    }
  }

  let score = 0
  let inGap = false
  let chunkBonus = 0
  let lastMatch = -2
  qi = 0
  for (let i = start; i <= end && qi < query.length; i++) {
    if (folded[i] !== query[qi]) {
      if (qi > 0) score += inGap ? GAP_EXTENSION : GAP_START
      inGap = true
      continue
    }
    let bonus = boundaryBonus(text, i)
    // A consecutive run keeps the bonus of the word start it began on, so
    // `view` fully inside `GraphView` scores like the hump it starts at.
    if (i === lastMatch + 1) bonus = Math.max(bonus, chunkBonus, BONUS_CONSECUTIVE)
    chunkBonus = bonus
    score += SCORE_MATCH + (qi === 0 ? bonus * FIRST_CHAR_MULTIPLIER : bonus)
    positions?.push(i)
    lastMatch = i
    inGap = false
    qi++
  }
  return score
}

/** Fuzzy-match free text (commands, branch names, …). */
export function fuzzyMatch(query: string, text: string, folded = foldCase(text)): FuzzyMatch | null {
  const positions: number[] = []
  const score = scoreWindow(query, text, folded, positions)
  return score === null ? null : { score, positions }
}

/** Score-only {@link fuzzyMatch}: no allocation, for ranking huge lists. */
export function fuzzyScore(query: string, text: string, folded = foldCase(text)): number | null {
  return scoreWindow(query, text, folded, null)
}

/**
 * Fuzzy-match a `/`-separated path, preferring a match inside the file name
 * (with a bonus) and falling back to the whole path — so `graphview` finds
 * `src/components/graph/GraphView.tsx` by its name, while `comp/graph`
 * still reaches across directories.
 */
export function fuzzyMatchPath(
  query: string,
  path: string,
  folded = foldCase(path)
): FuzzyMatch | null {
  const base = path.lastIndexOf('/') + 1
  if (base > 0) {
    const positions: number[] = []
    const score = scoreWindow(query, path.slice(base), folded.slice(base), positions)
    if (score !== null) {
      return { score: score + BONUS_BASENAME, positions: positions.map((p) => p + base) }
    }
  }
  return fuzzyMatch(query, path, folded)
}

/** Score-only {@link fuzzyMatchPath}. */
export function fuzzyScorePath(query: string, path: string, folded = foldCase(path)): number | null {
  const base = path.lastIndexOf('/') + 1
  if (base > 0) {
    const score = scoreWindow(query, path.slice(base), folded.slice(base), null)
    if (score !== null) return score + BONUS_BASENAME
  }
  return scoreWindow(query, path, folded, null)
}

/**
 * Keeps the best `limit` of a stream of scored items without sorting (or
 * even holding) the rest: higher score first, then the shorter text, then
 * arrival order. `total` counts every item offered, for "N more" hints.
 */
export class TopMatches<T> {
  private readonly entries: { item: T; score: number; length: number }[] = []
  total = 0

  constructor(private readonly limit: number) {}

  add(item: T, score: number, length: number): void {
    this.total++
    const entries = this.entries
    if (entries.length === this.limit && !ranksBefore(score, length, entries[entries.length - 1])) {
      return
    }
    // Binary search for the insertion point; ties keep arrival order.
    let lo = 0
    let hi = entries.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ranksBefore(score, length, entries[mid])) hi = mid
      else lo = mid + 1
    }
    entries.splice(lo, 0, { item, score, length })
    if (entries.length > this.limit) entries.pop()
  }

  items(): T[] {
    return this.entries.map((e) => e.item)
  }
}

function ranksBefore(score: number, length: number, other: { score: number; length: number }) {
  return score > other.score || (score === other.score && length < other.length)
}
