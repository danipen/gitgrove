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

  test('hideMerged drops merged and deleted branches, never HEAD or default', () => {
    const commits = [
      commit('w', ['m'], 'wip'),
      commit('m', ['b', 'f2'], 'HEAD -> main', "Merge branch 'gone'"),
      commit('f2', ['f1'], 'feature'),
      commit('f1', ['a']),
      commit('b', ['a']),
      commit('a', [])
    ]
    // feature's tip f2 was merged by m; wip's tip was not; 'gone' chains are
    // unnamed (merged by definition) and vanish with the flag.
    const layout = layoutGraph(input(commits, { hideMerged: true }))
    expect(layout.rows.map((r) => r.name).sort()).toEqual(['main', 'wip'])
    // The merge's second parent fell away → truncated marker, like filtering.
    expect(layout.nodeByHash.get('m')?.truncated).toBe(true)
  })

  test('structureOnly collapses linear runs and bridges the gaps', () => {
    // main: a ─ b ─ c ─ m(merge)     feature: f1 ─ f2 ─ f3
    const layout = layoutGraph(
      input(
        [
          commit('m', ['c', 'f3'], 'HEAD -> main'),
          commit('f3', ['f2'], 'feature'),
          commit('f2', ['f1']),
          commit('f1', ['a']),
          commit('c', ['b']),
          commit('b', ['a']),
          commit('a', [])
        ],
        { structureOnly: true }
      )
    )
    // Interior commits vanish: b, c (plain run on main) and f2 (run on feature).
    expect(layout.nodeByHash.get('b')).toBe(undefined)
    expect(layout.nodeByHash.get('c')).toBe(undefined)
    expect(layout.nodeByHash.get('f2')).toBe(undefined)
    // Survivors: root/fork point a, merge m, feature start f1 and tip f3.
    expect(layout.columnCount).toBe(4)
    // Bridged edges: m's first parent resolves through c,b to a (same-chain
    // line — no truncated stub), f3 bridges to f1, and the structure edges
    // (fork f1→a, merge m→f3) survive intact.
    expect(layout.nodeByHash.get('m')?.truncated).toBe(false)
    const kinds = layout.edges.map((e) => e.kind).sort()
    expect(kinds).toEqual(['fork', 'line', 'line', 'merge'])
  })

  test('packing reserves the merge lead-out so connector runs stay clear', () => {
    // early sits at column 2 but merges two columns later at m1 (column 4):
    // its connector runs along the row to column 4. late's reservation starts
    // at column 4 — without the lead-out they'd share row 1 and the connector
    // would run under late's footprint; with it, late moves down a row.
    const layout = layoutGraph(
      input([
        commit('m2', ['c5', 'y'], 'HEAD -> main', "Merge branch 'late'"),
        commit('y', ['c5'], 'late'),
        commit('c5', ['c4']),
        commit('c4', ['m1']),
        commit('m1', ['c3', 'x'], '', "Merge branch 'early'"),
        commit('c3', ['c1']),
        commit('x', ['c1'], 'early'),
        commit('c1', ['a']),
        commit('a', [])
      ])
    )
    expect(rowNamed(layout, 'early').index).toBe(1)
    expect(rowNamed(layout, 'late').index).toBe(2)
  })

  test('release lines stack directly under the mainline, newest version first', () => {
    // 10.x forked before 11.x and both overlap main's span; feature has the
    // newest tip of all but must not take a row above the release lines.
    const layout = layoutGraph(
      input([
        commit('f', ['b'], 'feature'),
        commit('m', ['b'], 'HEAD -> main'),
        commit('y2', ['y1'], '11.x'),
        commit('x2', ['x1'], '10.x'),
        commit('y1', ['b']),
        commit('x1', ['a']),
        commit('b', ['a']),
        commit('a', [])
      ])
    )
    expect(rowNamed(layout, 'main').index).toBe(0)
    expect(rowNamed(layout, '11.x').index).toBe(1)
    expect(rowNamed(layout, '10.x').index).toBe(2)
    expect(rowNamed(layout, 'feature').index).toBe(3)
  })

  test('a release line claims its spine before a newer branch forked from it', () => {
    // Without the release pin, feature's newer tip would walk down the first
    // parents and claim 11.x's commits, leaving no 11.x row at all.
    const layout = layoutGraph(
      input(
        [
          commit('f', ['y2'], 'HEAD -> feature'),
          commit('y2', ['y1'], '11.x'),
          commit('m', ['a'], 'main'),
          commit('y1', ['a']),
          commit('a', [])
        ],
        { headBranch: 'feature' }
      )
    )
    const release = rowNamed(layout, '11.x')
    expect(layout.nodeByHash.get('y1')?.row).toBe(release.index)
    expect(layout.nodeByHash.get('y2')?.row).toBe(release.index)
    expect(rowNamed(layout, 'feature').baseHash).toBe('y2')
  })

  test('hideMerged keeps release lines even when merged up into main', () => {
    // Merge-up workflow: 11.x merged into main makes 11.x's tip a merge
    // source, but the release line must survive the filter — it isn't done.
    const layout = layoutGraph(
      input(
        [
          commit('m2', ['m1', 'y2'], 'HEAD -> main', "Merge branch '11.x'"),
          commit('y2', ['y1'], '11.x'),
          commit('m1', ['a']),
          commit('y1', ['a']),
          commit('a', [])
        ],
        { hideMerged: true }
      )
    )
    expect(layout.rows.map((r) => r.name)).toEqual(['main', '11.x'])
  })

  test('collectBranchNames puts release lines right after the default branch', () => {
    const names = collectBranchNames(
      input([
        commit('f', ['a'], 'feature'),
        commit('x', ['a'], '10.x'),
        commit('y', ['a'], '11.x'),
        commit('m', ['a'], 'HEAD -> main'),
        commit('a', [])
      ])
    )
    expect(names).toEqual(['main', '11.x', '10.x', 'feature'])
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
