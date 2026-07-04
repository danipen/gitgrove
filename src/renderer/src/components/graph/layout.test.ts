import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import { collectBranchNames, type GraphInput, layoutGraph, rowMatchesSelection } from './layout'

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
      input([commit('ccc', ['bbb'], 'HEAD -> main'), commit('bbb', ['aaa']), commit('aaa', [])])
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

  test('merge nodes carry the incoming branch color; other nodes carry none', () => {
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
    const feature = rowNamed(layout, 'feature')
    // The merge ring wears the merged-in branch's palette slot — the same
    // color its merge edge draws in, so line and ring read as one thing.
    expect(layout.nodeByHash.get('m')?.mergeColor).toBe(feature.color)
    expect(layout.nodeByHash.get('b')?.mergeColor).toBeNull()
    expect(layout.nodeByHash.get('f2')?.mergeColor).toBeNull()
  })

  test('a merge whose merged parent is outside the window gets no merge color', () => {
    // m's second parent never loaded: still isMerge, but there is no incoming
    // edge to color a ring after — the node draws as a plain commit.
    const layout = layoutGraph(
      input([commit('m', ['b', 'zzz'], 'HEAD -> main'), commit('b', ['a']), commit('a', [])])
    )
    const m = layout.nodeByHash.get('m')
    expect(m?.isMerge).toBe(true)
    expect(m?.mergeColor).toBeNull()
    expect(m?.truncated).toBe(true)
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
      input([commit('m', ['a'], 'main'), commit('d', ['a'], 'HEAD'), commit('a', [])], {
        detached: true,
        headBranch: ''
      })
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
      input([commit('f', ['a'], 'HEAD -> feature'), commit('m', ['a'], 'main'), commit('a', [])], {
        headBranch: 'feature'
      })
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
        input([commit('m', ['a'], 'HEAD -> main'), commit('f', ['a'], 'feature'), commit('a', [])])
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

  test('a merged branch keeps its spine from a newer branch forked off its middle', () => {
    // The PR #74 / #75 shape: gen (g1─g2─g3─g4) merged into main, while the
    // checked-out extra forked from g3 and kept going (e1─e2). Without the
    // merged-tip pin, extra's newer tip walks down through g3─g2─g1 and
    // steals them, leaving gen a single orphaned commit (g4).
    const layout = layoutGraph(
      input(
        [
          commit('e2', ['e1'], 'HEAD -> extra'),
          commit('m2', ['m1', 'g4'], 'main', 'Merge pull request #74 from danipen/gen'),
          commit('g4', ['g3'], 'gen'),
          commit('e1', ['g3']),
          commit('g3', ['g2']),
          commit('g2', ['g1']),
          commit('g1', ['m1']),
          commit('m1', [])
        ],
        { headBranch: 'extra' }
      )
    )
    const gen = rowNamed(layout, 'gen')
    for (const hash of ['g1', 'g2', 'g3', 'g4']) {
      expect(layout.nodeByHash.get(hash)?.chain).toBe(gen.chain)
    }
    // extra owns only its unique commits and forks from gen's g3.
    const extra = rowNamed(layout, 'extra')
    expect(layout.nodeByHash.get('e1')?.chain).toBe(extra.chain)
    expect(extra.baseHash).toBe('g3')
    expect(gen.baseHash).toBe('m1')
    // And the child branch hangs BELOW the branch it grew from, even though
    // it's checked out and has the newer tip.
    expect(gen.index).toBe(1)
    expect(extra.index).toBe(2)
  })

  test('child branches pack below their parent, grandchildren below both', () => {
    // parent (merged into main) ← child (HEAD, forked from p1) ← grandchild
    // (forked from c1): each fork level hangs one row further from the
    // mainline, whatever the tip order says.
    const layout = layoutGraph(
      input(
        [
          commit('gg1', ['c1'], 'grandchild'),
          commit('c2', ['c1'], 'HEAD -> child'),
          commit('M', ['a', 'p2'], 'main', "Merge branch 'parent'"),
          commit('p2', ['p1'], 'parent'),
          commit('c1', ['p1']),
          commit('p1', ['a']),
          commit('a', [])
        ],
        { headBranch: 'child' }
      )
    )
    expect(rowNamed(layout, 'parent').index).toBe(1)
    expect(rowNamed(layout, 'child').index).toBe(2)
    expect(rowNamed(layout, 'grandchild').index).toBe(3)
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

  test('releaseOverrides pin a branch in and knock a detected one out', () => {
    // "lts" is invisible to the name heuristic; "11.x" is detected but the
    // user unpinned it — the override map must flip both.
    const names = collectBranchNames(
      input(
        [
          commit('f', ['a'], 'feature'),
          commit('l', ['a'], 'lts'),
          commit('y', ['a'], '11.x'),
          commit('m', ['a'], 'HEAD -> main'),
          commit('a', [])
        ],
        {
          releaseOverrides: new Map([
            ['lts', true],
            ['11.x', false]
          ])
        }
      )
    )
    expect(names).toEqual(['main', 'lts', 'feature', '11.x'])
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

describe('empty branches (zero-commit refs)', () => {
  test("a branch pointing at another chain's commit gets an empty lane", () => {
    const layout = layoutGraph(input([commit('b', ['a'], 'HEAD -> main, fresh'), commit('a', [])]))
    const fresh = rowNamed(layout, 'fresh')
    expect(fresh.empty).toBe(true)
    expect(fresh.kind).toBe('branch')
    // tip and base both name the anchor: the branch-changes range is empty.
    expect(fresh.tipHash).toBe('b')
    expect(fresh.baseHash).toBe('b')
    // One reserved slot right of the anchor, on its own row below main.
    expect(fresh.startColumn).toBe(2)
    expect(fresh.endColumn).toBe(2)
    expect(fresh.index).toBeGreaterThan(rowNamed(layout, 'main').index)
    // It claimed no commits — main keeps its whole spine…
    expect(layout.nodes.every((n) => n.chain !== fresh.chain)).toBe(true)
    expect(layout.nodeByHash.get('b')?.row).toBe(0)
    // …and a fork connector reaches from the anchor into the reserved slot.
    const fork = layout.edges.find((e) => e.kind === 'fork')
    expect(fork?.toColumn).toBe(1)
    expect(fork?.toRow).toBe(0)
    expect(fork?.fromColumn).toBe(2)
    expect(fork?.fromRow).toBe(fresh.index)
    // HEAD is on main, so main keeps the marker.
    expect(rowNamed(layout, 'main').isHead).toBe(true)
    expect(fresh.isHead).toBe(false)
    expect(layout.nodeByHash.get('b')?.isHead).toBe(true)
  })

  test('HEAD on an empty branch moves the home marker to the empty lane', () => {
    const layout = layoutGraph(
      input([commit('b', ['a'], 'HEAD -> fresh, main'), commit('a', [])], { headBranch: 'fresh' })
    )
    const fresh = rowNamed(layout, 'fresh')
    expect(fresh.empty).toBe(true)
    expect(fresh.isHead).toBe(true)
    expect(rowNamed(layout, 'main').isHead).toBe(false)
    // The anchor node stays plain: home lives on the empty lane now.
    expect(layout.nodeByHash.get('b')?.isHead).toBe(false)
    // headHash still names the anchor commit (jump-to-home target).
    expect(layout.headHash).toBe('b')
  })

  test('an empty branch anchored mid-spine hangs beside its anchor', () => {
    const layout = layoutGraph(
      input([commit('c', ['b'], 'HEAD -> main'), commit('b', ['a'], 'fresh'), commit('a', [])])
    )
    const fresh = rowNamed(layout, 'fresh')
    expect(fresh.empty).toBe(true)
    // Anchor b sits at column 1; the slot is the next column, one row down.
    expect(fresh.startColumn).toBe(2)
    expect(fresh.index).toBeGreaterThan(0)
  })

  test('a remote-only zero-commit ref becomes an empty remote lane', () => {
    const layout = layoutGraph(
      input([commit('b', ['a'], 'HEAD -> main, origin/fresh'), commit('a', [])])
    )
    const fresh = rowNamed(layout, 'fresh')
    expect(fresh.empty).toBe(true)
    expect(fresh.kind).toBe('remote')
  })

  test('two empty branches at one commit stack on separate rows', () => {
    const layout = layoutGraph(
      input([commit('b', ['a'], 'HEAD -> main, one, two'), commit('a', [])])
    )
    const one = rowNamed(layout, 'one')
    const two = rowNamed(layout, 'two')
    expect(one.empty).toBe(true)
    expect(two.empty).toBe(true)
    // Same reserved slot column — the packer must give them separate rows.
    expect(one.startColumn).toBe(two.startColumn)
    expect(one.index).not.toBe(two.index)
  })

  test('empty branches appear in the branch filter list', () => {
    const names = collectBranchNames(
      input([commit('b', ['a'], 'HEAD -> main, fresh'), commit('a', [])])
    )
    expect(names).toContain('fresh')
  })

  test('selection matches one row even when empty branches share a tip hash', () => {
    // main, one and two all point at commit b: selecting 'one' must light
    // only 'one' — a tip-hash-only match would light all three.
    const layout = layoutGraph(
      input([commit('b', ['a'], 'HEAD -> main, one, two'), commit('a', [])])
    )
    const selection = { name: 'one', tipHash: 'b' }
    const lit = layout.rows.filter((r) => rowMatchesSelection(r, selection))
    expect(lit).toHaveLength(1)
    expect(lit[0].name).toBe('one')
    expect(layout.rows.some((r) => rowMatchesSelection(r, null))).toBe(false)
  })

  test('origin/HEAD never becomes an empty lane (still shows when it owns commits)', () => {
    // origin/HEAD rides the default branch's tip: a pointer, not a branch.
    const layout = layoutGraph(
      input([commit('b', ['a'], 'HEAD -> main, origin/HEAD'), commit('a', [])])
    )
    expect(layout.rows.some((r) => r.name === 'HEAD')).toBe(false)
    // But a HEAD ref that claims commits of its own keeps its row, as before.
    const claimed = layoutGraph(
      input([
        commit('h', ['a'], 'origin/HEAD'),
        commit('b', ['a'], 'HEAD -> main'),
        commit('a', [])
      ])
    )
    const headRow = claimed.rows.find((r) => r.name === 'HEAD')
    expect(headRow?.empty).toBe(false)
  })

  test('local and remote refs at an already-claimed commit share one empty lane', () => {
    const layout = layoutGraph(
      input([commit('b', ['a'], 'HEAD -> main, fresh, origin/fresh'), commit('a', [])])
    )
    const rows = layout.rows.filter((r) => r.name === 'fresh')
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('branch')
    expect(rows[0].empty).toBe(true)
  })
})
