import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import { squashQuery } from './squash'

/** Minimal commit; only hash/parents/refs matter here. */
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

describe('squashQuery', () => {
  test('asks about branches off the mainline, each with its merge base', () => {
    // main: a ── b ── s (squash of feature)     feature: f1 ── f2 (from a)
    const query = squashQuery(
      [
        commit('s', ['b'], 'HEAD -> main'),
        commit('f2', ['f1'], 'feature'),
        commit('f1', ['a']),
        commit('b', ['a']),
        commit('a', [])
      ],
      ['origin'],
      'main'
    )
    expect(query).toEqual({
      mainline: ['s', 'b', 'a'],
      candidates: [{ tip: 'f2', base: 'a' }]
    })
  })

  test('never asks about a branch already merged by ancestry', () => {
    const query = squashQuery(
      [
        commit('m', ['b', 'f1'], 'HEAD -> main'),
        commit('f1', ['a'], 'feature'),
        commit('b', ['a']),
        commit('a', [])
      ],
      ['origin'],
      'main'
    )
    expect(query).toBeNull()
  })

  test('follows the remote default branch when it is ahead of the local one', () => {
    // The host squashed onto origin/main; local main hasn't pulled yet.
    const query = squashQuery(
      [
        commit('s', ['a'], 'origin/main'),
        commit('f1', ['a'], 'feature'),
        commit('a', [], 'HEAD -> main')
      ],
      ['origin'],
      'main'
    )
    expect(query?.mainline).toEqual(['s', 'a'])
    expect(query?.candidates).toEqual([{ tip: 'f1', base: 'a' }])
  })

  test('takes the newest meeting point after the branch synced the mainline', () => {
    // feature merged main (at b) back in, so its own changes start at b.
    const query = squashQuery(
      [
        commit('f2', ['f1', 'b'], 'feature'),
        commit('b', ['a'], 'main'),
        commit('f1', ['a']),
        commit('a', [])
      ],
      ['origin'],
      'main'
    )
    expect(query?.candidates).toEqual([{ tip: 'f2', base: 'b' }])
  })

  test('skips tags, bare HEAD, and tips whose base is outside the window', () => {
    const query = squashQuery(
      [
        commit('t', ['a'], 'tag: v1'),
        commit('d', ['a'], 'HEAD'),
        commit('o', ['gone'], 'orphan'),
        commit('a', [], 'main')
      ],
      ['origin'],
      'main'
    )
    expect(query).toBeNull()
  })

  test('has nothing to ask without a default branch in view', () => {
    const commits = [commit('f1', ['a'], 'feature'), commit('a', [])]
    expect(squashQuery(commits, ['origin'], null)).toBeNull()
    expect(squashQuery(commits, ['origin'], 'main')).toBeNull()
  })
})
