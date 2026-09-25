import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import { type GraphInput, layoutGraph } from './layout'
import { resolveReveal } from './reveal'

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

function input(commits: Commit[]): GraphInput {
  return {
    commits,
    remotes: ['origin'],
    headBranch: 'main',
    detached: false,
    defaultBranch: 'main'
  }
}

// main: a ── b          feature (and origin/feature): a ── f
const layout = layoutGraph(
  input([
    commit('b', ['a'], 'HEAD -> main'),
    commit('f', ['a'], 'feature, origin/feature'),
    commit('a', [])
  ])
)

describe('resolveReveal', () => {
  test('a local branch resolves to its row', () => {
    const hit = resolveReveal({ kind: 'branch', name: 'feature', hash: 'f' }, layout, ['origin'])
    expect(hit?.kind === 'row' && hit.row.name).toBe('feature')
  })

  test('a remote branch resolves to the row it shares with its local twin', () => {
    const hit = resolveReveal({ kind: 'branch', name: 'origin/feature', hash: 'f' }, layout, [
      'origin'
    ])
    expect(hit?.kind === 'row' && hit.row.tipHash).toBe('f')
  })

  test('a branch without a row falls back to its tip commit', () => {
    const hit = resolveReveal({ kind: 'branch', name: 'gone', hash: 'b' }, layout, ['origin'])
    expect(hit?.kind === 'node' && hit.node.commit.hash).toBe('b')
  })

  test('a commit resolves to its node', () => {
    const hit = resolveReveal({ kind: 'commit', hash: 'a' }, layout, ['origin'])
    expect(hit?.kind === 'node' && hit.node.commit.hash).toBe('a')
  })

  test('anything outside the loaded window is a miss', () => {
    expect(resolveReveal({ kind: 'commit', hash: 'zzz' }, layout, ['origin'])).toBeNull()
    expect(resolveReveal({ kind: 'branch', name: 'old', hash: 'zzz' }, layout, [])).toBeNull()
  })
})
