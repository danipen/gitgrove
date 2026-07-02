import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import { type GraphInput, layoutGraph } from './layout'
import { relatedBranches } from './related'

/** Minimal commit for tests; only hash/parents/refs/subject matter. */
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

describe('relatedBranches', () => {
  test('fork parent, forked children and merge sources are one hop away', () => {
    // feature forked from main and merged back; sub forked from feature.
    const layout = layoutGraph(
      input([
        commit('m2', ['m1', 'f2'], 'HEAD -> main'),
        commit('f2', ['f1'], 'feature'),
        commit('s', ['f1'], 'sub'),
        commit('f1', ['m1']),
        commit('m1', [])
      ])
    )
    expect(relatedBranches(layout, 'feature', 1)).toEqual(new Set(['feature', 'main', 'sub']))
    expect(relatedBranches(layout, 'main', 1)).toEqual(new Set(['main', 'feature']))
  })

  test('hops bound the walk: each chain in the path costs one', () => {
    // main ← b (forked from main) ← a (forked from b): a grandparent chain.
    const layout = layoutGraph(
      input([
        commit('m2', ['m1'], 'HEAD -> main'),
        commit('b2', ['b1'], 'b'),
        commit('a2', ['a1'], 'a'),
        commit('a1', ['b1']),
        commit('b1', ['m1']),
        commit('m1', [])
      ])
    )
    expect(relatedBranches(layout, 'a', 1)).toEqual(new Set(['a', 'b']))
    expect(relatedBranches(layout, 'a', 2)).toEqual(new Set(['a', 'b', 'main']))
  })

  test('unnamed chains conduct relatedness but never appear in the result', () => {
    // A deleted branch (unnamed chain) forked from feature and merged into
    // main: it links the two at a hop's cost, but isn't itself addressable.
    const layout = layoutGraph(
      input([
        commit('m2', ['m1', 'x'], 'HEAD -> main', "Merge branch 'gone'"),
        commit('x', ['f1']),
        commit('f1', ['m1'], 'feature'),
        commit('m1', [])
      ])
    )
    expect(relatedBranches(layout, 'feature', 1).has('gone')).toBe(false)
    expect(relatedBranches(layout, 'feature', 2)).toEqual(new Set(['feature', 'main']))
  })

  test('an isolated or absent seed is still the whole result', () => {
    const layout = layoutGraph(
      input([commit('m', ['a'], 'HEAD -> main'), commit('a', [])])
    )
    expect(relatedBranches(layout, 'main', 1)).toEqual(new Set(['main']))
    expect(relatedBranches(layout, 'ghost', 1)).toEqual(new Set(['ghost']))
  })
})
