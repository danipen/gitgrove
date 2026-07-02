import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import { type GraphInput, layoutGraph } from './layout'
import { backportLinks, linkableChains, linkedHashes, twinHashes } from './links'

/** Minimal commit for tests; only hash/parents/refs matter. */
function commit(hash: string, parents: string[], refs = ''): Commit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject: `subject ${hash}`,
    body: '',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    date: '2026-07-01T10:00:00+00:00',
    relativeDate: 'now',
    refs,
    parents
  }
}

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

// The backport shape: a fix on main cherry-picked onto 11.x — no merge edge
// connects them, only the shared patch-id does.
const layout = () =>
  layoutGraph(
    input([
      commit('m3', ['m2'], 'HEAD -> main'),
      commit('b', ['y1'], '11.x'),
      commit('m2', ['fix']),
      commit('fix', ['m1']),
      commit('y1', ['m1']),
      commit('m1', [])
    ])
  )

describe('backportLinks', () => {
  test('links commits sharing a patch-id, oldest end first', () => {
    const links = backportLinks(
      layout().nodes,
      new Map([
        ['fix', 'P1'],
        ['b', 'P1'],
        ['m2', 'P2']
      ])
    )
    expect(links).toEqual([{ fromHash: 'fix', toHash: 'b' }])
  })

  test('a chain of three lines yields consecutive pairs, not a triangle', () => {
    const graph = layoutGraph(
      input([
        commit('m2', ['fix'], 'HEAD -> main'),
        commit('b11', ['y1'], '11.x'),
        commit('b10', ['x1'], '10.x'),
        commit('fix', ['m1']),
        commit('y1', ['m1']),
        commit('x1', ['m1']),
        commit('m1', [])
      ])
    )
    const links = backportLinks(
      graph.nodes,
      new Map([
        ['fix', 'P'],
        ['b11', 'P'],
        ['b10', 'P']
      ])
    )
    expect(links).toHaveLength(2)
    const ends = links.flatMap((l) => [l.fromHash, l.toHash])
    // Chained: 4 endpoints but only 3 distinct commits (the middle is shared).
    expect(new Set(ends).size).toBe(3)
  })

  test('same-chain pairs and merges never link', () => {
    const graph = layout()
    const links = backportLinks(
      graph.nodes,
      new Map([
        ['m2', 'Q'],
        ['m1', 'Q'], // same chain (main) — reapplied history, not a backport
        ['m3', 'R'],
        ['b', 'R'] // cross-chain pair — links
      ])
    )
    expect(links).toEqual([{ fromHash: 'b', toHash: 'm3' }])
  })

  test('unknown patch-ids and singleton groups produce nothing', () => {
    expect(backportLinks(layout().nodes, new Map([['fix', 'P']]))).toEqual([])
    expect(backportLinks(layout().nodes, new Map())).toEqual([])
  })

  test('linkableChains keeps only mainline and release-line chains', () => {
    const graph = layoutGraph(
      input([
        commit('m', ['a'], 'HEAD -> main'),
        commit('y', ['a'], '11.x'),
        commit('f', ['a'], 'feature'),
        commit('a', [])
      ])
    )
    const names = (chains: ReadonlySet<number>) =>
      graph.rows
        .filter((r) => chains.has(r.chain))
        .map((r) => r.name)
        .sort()
    expect(names(linkableChains(graph.rows, 'main'))).toEqual(['11.x', 'main'])
    // An unpinned release line drops out; a pinned oddball comes in.
    const overrides = new Map([
      ['11.x', false],
      ['feature', true]
    ])
    expect(names(linkableChains(graph.rows, 'main', overrides))).toEqual(['feature', 'main'])
  })

  test('twinHashes returns the other ends of every touching link', () => {
    const links = [
      { fromHash: 'a', toHash: 'b' },
      { fromHash: 'b', toHash: 'c' }
    ]
    expect(twinHashes(links, 'a')).toEqual(['b'])
    expect(twinHashes(links, 'b')).toEqual(['a', 'c'])
    expect(twinHashes(links, 'z')).toEqual([])
  })

  test('linkedHashes collects every endpoint once', () => {
    expect(
      linkedHashes([
        { fromHash: 'a', toHash: 'b' },
        { fromHash: 'b', toHash: 'c' }
      ])
    ).toEqual(new Set(['a', 'b', 'c']))
  })
})
