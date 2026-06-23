// Wrap the matched portions of a filtered list item so they stand out. The
// renderer's list filters all match case-insensitive substrings, so this
// mirrors that: every occurrence of each term inside `text` is wrapped in a
// <mark>. Returns the plain string untouched when there's no term or no match,
// so unfiltered rows pay nothing.

import type { ReactNode } from 'react'

/** Single-substring highlight, for filters that match the whole query as one. */
export function highlightMatch(text: string, query: string): ReactNode {
  return highlightTerms(text, [query])
}

/**
 * Multi-term highlight, for filters that split on whitespace and require every
 * term (e.g. the clone repo picker). Each term's occurrences are highlighted;
 * overlapping/adjacent matches are merged into one <mark> so they never nest.
 */
export function highlightTerms(text: string, terms: string[]): ReactNode {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (needles.length === 0) return text

  const hay = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const needle of needles) {
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
      ranges.push([at, at + needle.length])
    }
  }
  if (ranges.length === 0) return text

  // Merge overlapping/touching ranges so two terms that abut yield one <mark>.
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [ranges[0]]
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1]
    if (start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }

  const parts: ReactNode[] = []
  let from = 0
  for (const [start, end] of merged) {
    if (start > from) parts.push(text.slice(from, start))
    parts.push(
      <mark key={start} className="hl">
        {text.slice(start, end)}
      </mark>
    )
    from = end
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}
