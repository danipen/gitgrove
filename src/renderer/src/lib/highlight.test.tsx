import { describe, expect, it } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'
import { highlightMatch, highlightTerms } from './highlight'

// Flatten a highlight result into ordered text/marked tokens so we can assert on
// what's highlighted without rendering to a DOM.
function tokens(node: ReactNode): Array<{ text: string; marked: boolean }> {
  const parts = Array.isArray(node) ? node : [node]
  return parts.map((part) => {
    if (isValidElement<{ children: ReactNode }>(part)) {
      return { text: String(part.props.children), marked: true }
    }
    return { text: String(part), marked: false }
  })
}

describe('highlightMatch', () => {
  it('returns the plain text untouched when there is no query', () => {
    expect(highlightMatch('gitgrove', '   ')).toBe('gitgrove')
  })

  it('returns the plain text untouched when nothing matches', () => {
    expect(highlightMatch('gitgrove', 'zzz')).toBe('gitgrove')
  })

  it('wraps the single matched substring', () => {
    expect(tokens(highlightMatch('gitgrove', 'grove'))).toEqual([
      { text: 'git', marked: false },
      { text: 'grove', marked: true }
    ])
  })
})

describe('highlightTerms', () => {
  it('highlights every term independently', () => {
    expect(tokens(highlightTerms('git-grove-client', ['git', 'client']))).toEqual([
      { text: 'git', marked: true },
      { text: '-grove-', marked: false },
      { text: 'client', marked: true }
    ])
  })

  it('merges overlapping/adjacent matches into one mark', () => {
    // "grov" and "rove" overlap; "grove" should emerge as a single mark.
    expect(tokens(highlightTerms('gitgrove', ['grov', 'rove']))).toEqual([
      { text: 'git', marked: false },
      { text: 'grove', marked: true }
    ])
  })

  it('is case-insensitive', () => {
    expect(tokens(highlightTerms('GitGrove', ['grove']))).toEqual([
      { text: 'Git', marked: false },
      { text: 'Grove', marked: true }
    ])
  })

  it('returns plain text when no term matches', () => {
    expect(highlightTerms('gitgrove', ['zzz'])).toBe('gitgrove')
  })
})
