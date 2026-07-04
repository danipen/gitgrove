import { describe, expect, test } from 'bun:test'
import { computeSearchHits, hitKey, litChains, pingRings, withAlpha } from './searchGlow'

describe('pingRings', () => {
  test('settled pulse draws nothing', () => {
    expect(pingRings(1)).toEqual([])
    expect(pingRings(1.5)).toEqual([])
  })

  test('out-of-range pulse draws nothing', () => {
    expect(pingRings(-0.1)).toEqual([])
  })

  test('launch moment: only the first ring, at the start radius', () => {
    const rings = pingRings(0.01)
    expect(rings.length).toBe(1)
    expect(rings[0].grow).toBeLessThan(1)
    expect(rings[0].alpha).toBeGreaterThan(0.6)
  })

  test('mid-ping: both staggered rings, the older one further out and fainter', () => {
    const rings = pingRings(0.6)
    expect(rings.length).toBe(2)
    const [first, second] = rings
    expect(first.grow).toBeGreaterThan(second.grow)
    expect(first.alpha).toBeLessThan(second.alpha)
  })

  test('rings expand and fade monotonically over the pulse', () => {
    let lastGrow = -1
    let lastAlpha = 2
    for (const pulse of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const first = pingRings(pulse)[0]
      expect(first.grow).toBeGreaterThan(lastGrow)
      expect(first.alpha).toBeLessThan(lastAlpha)
      lastGrow = first.grow
      lastAlpha = first.alpha
    }
  })
})

describe('withAlpha', () => {
  test('expands #rrggbb tokens', () => {
    expect(withAlpha('#d6a027', 0.5)).toBe('rgba(214, 160, 39, 0.5)')
  })

  test('expands #rgb shorthand', () => {
    expect(withAlpha('#f00', 0.25)).toBe('rgba(255, 0, 0, 0.25)')
  })

  test('zero alpha is honored (transparent gradient stop)', () => {
    expect(withAlpha('#9a6700', 0)).toBe('rgba(154, 103, 0, 0)')
  })

  test('non-hex colors pass through untouched', () => {
    expect(withAlpha('hsl(214 72% 64%)', 0.5)).toBe('hsl(214 72% 64%)')
  })

  test('cached calls stay stable', () => {
    expect(withAlpha('#d6a027', 0.5)).toBe(withAlpha('#d6a027', 0.5))
  })
})

describe('litChains', () => {
  const node = (chain: number, hash: string) => ({ chain, commit: { hash } })

  test('collects only chains holding a match', () => {
    const nodes = [node(0, 'a'), node(0, 'b'), node(1, 'c'), node(2, 'd')]
    const lit = litChains(nodes, new Set(['b', 'd']))
    expect(lit.has(0)).toBe(true)
    expect(lit.has(1)).toBe(false)
    expect(lit.has(2)).toBe(true)
  })

  test('no matches lights nothing (every label ghosts)', () => {
    const nodes = [node(0, 'a'), node(1, 'b')]
    expect(litChains(nodes, new Set()).size).toBe(0)
  })

  test('branch-label hits light their chain regardless of commits', () => {
    const nodes = [node(0, 'a'), node(1, 'b')]
    const lit = litChains(nodes, new Set(['a']), new Set([2]))
    expect(lit.has(0)).toBe(true)
    expect(lit.has(1)).toBe(false)
    expect(lit.has(2)).toBe(true)
  })
})

describe('computeSearchHits', () => {
  const mkNode = (hash: string, subject: string, column: number, row = 0, refs: string[] = []) => ({
    commit: { hash, subject, authorName: 'Dani', authorEmail: 'dani@x.com' },
    refs: refs.map((name) => ({ name, isTag: name.startsWith('v') })),
    column,
    row
  })
  const mkRow = (chain: number, name: string, startColumn: number, index = chain) => ({
    chain,
    name,
    index,
    startColumn
  })

  test('nothing to filter by yields no hits', () => {
    expect(computeSearchHits([], null, [mkNode('a', 'x', 0)], [mkRow(0, 'main', 0)])).toEqual([])
  })

  test('a branch name finds the LABEL, not any commit', () => {
    const nodes = [mkNode('a', 'Modified cs 8', 5)]
    const rows = [mkRow(0, 'main', 0), mkRow(1, 'something6-1', 6)]
    expect(computeSearchHits(['something6-1'], null, nodes, rows)).toEqual([
      { kind: 'branch', chain: 1 }
    ])
  })

  test('a tag name finds the CHIP; multiple matching tags are one stop', () => {
    const nodes = [mkNode('a', 'Release', 3, 0, ['v1.2.0', 'v1.2.0-rc1'])]
    expect(computeSearchHits(['v1.2.0'], null, nodes, [])).toEqual([{ kind: 'tag', hash: 'a' }])
  })

  test('mixed hits order newest-first, ref hits just before their commit', () => {
    const nodes = [mkNode('old', 'fix parser', 1, 0), mkNode('new', 'fix diff', 4, 0, ['vfix'])]
    const rows = [mkRow(1, 'fix-layout', 2, 1)]
    expect(computeSearchHits(['fix'], null, nodes, rows)).toEqual([
      { kind: 'tag', hash: 'new' },
      { kind: 'commit', hash: 'new' },
      { kind: 'branch', chain: 1 },
      { kind: 'commit', hash: 'old' }
    ])
  })

  test('the author filter gates commits but never branches or tags', () => {
    const nodes = [mkNode('a', 'fix things', 1, 0, ['vfix'])]
    const rows = [mkRow(0, 'fix-layout', 0)]
    const hits = computeSearchHits(['fix'], new Set(['other@x.com']), nodes, rows)
    expect(hits).toEqual([
      { kind: 'tag', hash: 'a' },
      { kind: 'branch', chain: 0 }
    ])
  })

  test('author filter alone (no terms) yields commit hits only', () => {
    const nodes = [mkNode('a', 'anything', 0)]
    const rows = [mkRow(0, 'main', 0)]
    const hits = computeSearchHits([], new Set(['dani@x.com']), nodes, rows)
    expect(hits).toEqual([{ kind: 'commit', hash: 'a' }])
  })
})

describe('hitKey', () => {
  test('stable, distinct identities per kind', () => {
    expect(hitKey(null)).toBeNull()
    expect(hitKey({ kind: 'commit', hash: 'a' })).toBe('commit:a')
    expect(hitKey({ kind: 'tag', hash: 'a' })).toBe('tag:a')
    expect(hitKey({ kind: 'branch', chain: 3 })).toBe('branch:3')
    expect(hitKey({ kind: 'commit', hash: 'a' })).not.toBe(hitKey({ kind: 'tag', hash: 'a' }))
  })
})
