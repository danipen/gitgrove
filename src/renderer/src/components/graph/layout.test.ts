import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import { collectBranchNames, type GraphInput, layoutGraph } from './layout'

/** Minimal commit for layout tests; only hash/parents/refs/subject matter. */
function commit(hash: string, parents: string[], refs = '', subject = `subject ${hash}`): Commit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject,
    body: '',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    date: '2026-07-01T10:00:00+00:00',
    relativeDate: 'now',
    refs,
    parents
  }
}

/** Input with sensible defaults; commits must be newest-first (date order). */
function input(commits: Commit[], overrides: Partial<GraphInput> = {}): GraphInput {
  return {
    commits,
    remotes: ['origin'],
    headBranch: 'main',
    detached: false,
    defaultBranch: 'main',
    ...overrides
  }
}

const rowNamed = (layout: ReturnType<typeof layoutGraph>, name: string) => {
  const row = layout.rows.find((r) => r.name === name)
  if (!row) throw new Error(`no row named ${name}`)
  return row
}

describe('layoutGraph', () => {
  test('linear history is one row with ascending columns and line edges', () => {
    const layout = layoutGraph(
      input([
        commit('ccc', ['bbb'], 'HEAD -> main'),
        commit('bbb', ['aaa']),
        commit('aaa', [])
      ])
    )
    expect(layout.rows).toHaveLength(1)
    expect(layout.rows[0].name).toBe('main')
    expect(layout.rows[0].isHead).toBe(true)
    expect(layout.nodeByHash.get('aaa')?.column).toBe(0)
    expect(layout.nodeByHash.get('ccc')?.column).toBe(2)
    expect(layout.edges.map((e) => e.kind)).toEqual(['line', 'line'])
    expect(layout.headHash).toBe('ccc')
  })

  test('a feature branch gets its own row with fork and merge edges', () => {
    // main: a ── b ───── m (merge)      feature: f1 ── f2
    const layout = layoutGraph(
      input([
        commit('m', ['b', 'f2'], 'HEAD -> main'),
        commit('f2', ['f1'], 'feature'),
        commit('f1', ['a']),
        commit('b', ['a']),
        commit('a', [])
      ])
    )
    expect(layout.rows.map((r) => r.name)).toEqual(['main', 'feature'])
    expect(layout.rowCount).toBe(2)
    const feature = rowNamed(layout, 'feature')
    expect(layout.nodeByHash.get('f1')?.row).toBe(feature.index)
    expect(layout.nodeByHash.get('f2')?.row).toBe(feature.index)
    const kinds = layout.edges.map((e) => e.kind).sort()
    // m→b line, m→f2 merge, f2→f1 line, f1→a fork, b→a line
    expect(kinds).toEqual(['fork', 'line', 'line', 'line', 'merge'])
    const merge = layout.edges.find((e) => e.kind === 'merge')
    expect(merge?.fromRow).toBe(0)
    expect(merge?.toRow).toBe(feature.index)
  })

  test('local and remote refs with one base name share a single row', () => {
    // origin/main two ahead of main; the walk from the remote tip claims both.
    const layout = layoutGraph(
      input([
        commit('r2', ['r1'], 'origin/main'),
        commit('r1', ['l'], ''),
        commit('l', [], 'HEAD -> main')
      ])
    )
    expect(layout.rows).toHaveLength(1)
    expect(layout.rows[0].name).toBe('main')
    expect(layout.rows[0].kind).toBe('branch')
    expect(layout.rows[0].isHead).toBe(true)
    expect(layout.headHash).toBe('l')
  })

  test('a remote-only branch becomes a remote row', () => {
    const layout = layoutGraph(
      input([
        commit('m', ['a'], 'HEAD -> main'),
        commit('f', ['a'], 'origin/feature'),
        commit('a', [])
      ])
    )
    expect(rowNamed(layout, 'feature').kind).toBe('remote')
  })

  test('deleted merged branches become unnamed rows, named from the merge subject', () => {
    const layout = layoutGraph(
      input([
        commit('m', ['b', 'x2'], 'HEAD -> main', "Merge branch 'fix/crash'"),
        commit('x2', ['x1']),
        commit('x1', ['a']),
        commit('b', ['a']),
        commit('a', [])
      ])
    )
    const unnamed = rowNamed(layout, 'fix/crash')
    expect(unnamed.kind).toBe('unnamed')
    expect(layout.nodeByHash.get('x1')?.row).toBe(unnamed.index)
    expect(layout.nodeByHash.get('x2')?.row).toBe(unnamed.index)
  })

  test('tags never create rows', () => {
    const layout = layoutGraph(
      input([commit('b', ['a'], 'HEAD -> main, tag: v1.0'), commit('a', [], 'tag: v0.9')])
    )
    expect(layout.rows).toHaveLength(1)
    expect(layout.nodeByHash.get('b')?.refs).toEqual([
      { name: 'main', isTag: false },
      { name: 'v1.0', isTag: true }
    ])
  })

  test('detached HEAD off every branch gets its own row', () => {
    const layout = layoutGraph(
      input(
        [
          commit('m', ['a'], 'main'),
          commit('d', ['a'], 'HEAD'),
          commit('a', [])
        ],
        { detached: true, headBranch: '' }
      )
    )
    const head = rowNamed(layout, 'HEAD')
    expect(head.kind).toBe('detached')
    expect(head.isHead).toBe(true)
    expect(layout.headHash).toBe('d')
  })

  test('missing parents mark the node truncated instead of erroring', () => {
    const layout = layoutGraph(input([commit('b', ['gone'], 'HEAD -> main')]))
    expect(layout.nodeByHash.get('b')?.truncated).toBe(true)
    expect(layout.edges).toHaveLength(0)
  })

  test('branch filter drops other branches and re-packs columns densely', () => {
    const layout = layoutGraph(
      input(
        [
          commit('m', ['b', 'f2'], 'HEAD -> main', "Merge branch 'feature'"),
          commit('f2', ['f1'], 'feature'),
          commit('f1', ['a']),
          commit('b', ['a']),
          commit('a', [])
        ],
        { visibleBranches: new Set(['main']) }
      )
    )
    expect(layout.rows.map((r) => r.name)).toEqual(['main'])
    expect(layout.columnCount).toBe(3)
    // Dense columns: a=0, b=1, m=2 — no gaps where feature commits sat.
    expect(layout.nodeByHash.get('a')?.column).toBe(0)
    expect(layout.nodeByHash.get('b')?.column).toBe(1)
    expect(layout.nodeByHash.get('m')?.column).toBe(2)
    // The merge parent fell outside the filter → truncated marker, no edge.
    expect(layout.nodeByHash.get('m')?.truncated).toBe(true)
  })

  test('default branch pins to row 0 even when another branch is newer', () => {
    const layout = layoutGraph(
      input(
        [
          commit('f', ['a'], 'HEAD -> feature'),
          commit('m', ['a'], 'main'),
          commit('a', [])
        ],
        { headBranch: 'feature' }
      )
    )
    expect(layout.rows[0].name).toBe('main')
    expect(layout.rows[1].name).toBe('feature')
    expect(layout.rows[1].isHead).toBe(true)
  })

  test('non-overlapping branches pack onto the same row near main', () => {
    // Two short-lived branches whose column spans (plus label padding) never
    // overlap — they must share row 1 instead of staircasing downwards.
    const layout = layoutGraph(
      input([
        commit('m2', ['c4', 'y'], 'HEAD -> main', "Merge branch 'late'"),
        commit('y', ['c4'], 'late'),
        commit('c4', ['c3']),
        commit('c3', ['c2']),
        commit('c2', ['m1']),
        commit('m1', ['c1', 'x'], '', "Merge branch 'early'"),
        commit('x', ['c1'], 'early'),
        commit('c1', ['a']),
        commit('a', [])
      ])
    )
    expect(rowNamed(layout, 'early').index).toBe(1)
    expect(rowNamed(layout, 'late').index).toBe(1)
    expect(layout.rowCount).toBe(2)
    // Same-chain hops stay lines; cross-chain first-parent hops stay forks
    // even when both chains share a packed row.
    const kinds = layout.edges.map((e) => e.kind)
    expect(kinds.filter((k) => k === 'merge')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'fork')).toHaveLength(2)
  })

  test('branch base hash feeds the branch-changes view', () => {
    const layout = layoutGraph(
      input([
        commit('m', ['b', 'f2'], 'HEAD -> main'),
        commit('f2', ['f1'], 'feature'),
        commit('f1', ['a']),
        commit('b', ['a']),
        commit('a', [])
      ])
    )
    // The branch grew from 'a'; the mainline starts at a root (no base).
    expect(rowNamed(layout, 'feature').baseHash).toBe('a')
    expect(rowNamed(layout, 'main').baseHash).toBeNull()
  })

  test('mainline keeps color slot 0; other branches get stable non-zero slots', () => {
    const build = () =>
      layoutGraph(
        input([
          commit('m', ['a'], 'HEAD -> main'),
          commit('f', ['a'], 'feature'),
          commit('a', [])
        ])
      )
    const first = build()
    expect(rowNamed(first, 'main').color).toBe(0)
    const slot = rowNamed(first, 'feature').color
    expect(slot === 0).toBe(false)
    // Stable across re-layouts: the same branch name keeps its color.
    expect(rowNamed(build(), 'feature').color).toBe(slot)
  })

  test('collectBranchNames lists base names in claim priority order', () => {
    const names = collectBranchNames(
      input(
        [
          commit('f', ['a'], 'feature'),
          commit('m', ['a'], 'HEAD -> main, origin/main'),
          commit('o', ['a'], 'origin/old'),
          commit('a', [])
        ],
        { headBranch: 'main' }
      )
    )
    expect(names).toEqual(['main', 'feature', 'old'])
  })

  test('nodes come out in ascending column order for range culling', () => {
    const layout = layoutGraph(
      input([
        commit('m', ['b', 'f'], 'HEAD -> main'),
        commit('f', ['a'], 'feature'),
        commit('b', ['a']),
        commit('a', [])
      ])
    )
    const columns = layout.nodes.map((n) => n.column)
    expect(columns).toEqual([...columns].sort((x, y) => x - y))
  })
})
