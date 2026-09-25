import { describe, expect, it } from 'bun:test'
import {
  foldCase,
  fuzzyMatch,
  fuzzyMatchPath,
  fuzzyScore,
  fuzzyScorePath,
  normalizeQuery,
  TopMatches
} from './fuzzy'

describe('normalizeQuery', () => {
  it('folds case and drops whitespace', () => {
    expect(normalizeQuery('  New  Branch ')).toBe('newbranch')
  })
})

describe('foldCase', () => {
  it('keeps the length even for code points that lowercase to two units', () => {
    const text = 'İstanbul'
    expect(foldCase(text)).toHaveLength(text.length)
    expect(foldCase(text).slice(1)).toBe('stanbul')
  })
})

describe('fuzzyMatch', () => {
  it('matches an in-order subsequence, case-insensitively', () => {
    expect(fuzzyMatch('nb', 'New Branch')?.positions).toEqual([0, 4])
  })

  it('rejects out-of-order and missing characters', () => {
    expect(fuzzyMatch('bw', 'New Branch')).toBeNull()
    expect(fuzzyMatch('xyz', 'New Branch')).toBeNull()
    expect(fuzzyMatch('toolongquery', 'short')).toBeNull()
  })

  it('treats an empty query as a zero-score match', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] })
  })

  it('tightens a false start to the shortest window', () => {
    // The first "a" leads nowhere closer; the match should hug "ab".
    expect(fuzzyMatch('ab', 'a---ab')?.positions).toEqual([4, 5])
  })

  it('ranks word-start matches above mid-word ones', () => {
    const boundary = fuzzyScore('fb', 'feature/bar')
    const midWord = fuzzyScore('fb', 'sofabed')
    expect(boundary).not.toBeNull()
    expect(midWord).not.toBeNull()
    expect(boundary!).toBeGreaterThan(midWord!)
  })

  it('ranks camelCase humps like word starts', () => {
    expect(fuzzyScore('gv', 'GraphView')!).toBeGreaterThan(fuzzyScore('gv', 'grave')!)
  })

  it('ranks consecutive runs above scattered matches', () => {
    expect(fuzzyScore('push', 'Push')!).toBeGreaterThan(fuzzyScore('push', 'Pull Such')!)
  })

  it('scores exactly what fuzzyScore reports', () => {
    expect(fuzzyMatch('fetch', 'Fetch All')?.score).toBe(fuzzyScore('fetch', 'Fetch All')!)
  })
})

describe('fuzzyMatchPath', () => {
  it('prefers a match inside the file name', () => {
    const match = fuzzyMatchPath('view', 'src/view/old/GraphView.tsx')
    // "view" lands on the basename's "View", not the directory.
    expect(match?.positions).toEqual([18, 19, 20, 21])
  })

  it('ranks a basename hit above a directory-spanning one', () => {
    const inName = fuzzyScorePath('graph', 'src/components/GraphView.tsx')!
    const acrossDirs = fuzzyScorePath('graph', 'g/r/a/p/h.ts')!
    expect(inName).toBeGreaterThan(acrossDirs)
  })

  it('falls back to the whole path when the name alone cannot match', () => {
    const match = fuzzyMatchPath('comp/gv', 'src/components/GraphView.tsx')
    expect(match).not.toBeNull()
    expect(match!.positions[0]).toBe(4)
  })

  it('matches root-level files by name', () => {
    expect(fuzzyMatchPath('read', 'README.md')?.positions).toEqual([0, 1, 2, 3])
  })

  it('scores exactly what fuzzyScorePath reports', () => {
    const path = 'src/renderer/App.tsx'
    expect(fuzzyMatchPath('app', path)?.score).toBe(fuzzyScorePath('app', path)!)
  })
})

describe('TopMatches', () => {
  it('keeps the best items, best first', () => {
    const top = new TopMatches<string>(2)
    top.add('low', 1, 3)
    top.add('high', 9, 4)
    top.add('mid', 5, 3)
    expect(top.items()).toEqual(['high', 'mid'])
    expect(top.total).toBe(3)
  })

  it('breaks ties by shorter text, then arrival order', () => {
    const top = new TopMatches<string>(3)
    top.add('long-first', 5, 10)
    top.add('short', 5, 5)
    top.add('long-second', 5, 10)
    expect(top.items()).toEqual(['short', 'long-first', 'long-second'])
  })
})
