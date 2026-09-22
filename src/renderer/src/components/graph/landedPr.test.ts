import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import { branchFromPrMergeSubject, landedPrOf } from './landedPr'

function commit(subject: string, body = ''): Commit {
  return {
    hash: 'abc1234def',
    shortHash: 'abc1234',
    subject,
    body,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    date: '2026-07-01T10:00:00+00:00',
    relativeDate: 'now',
    refs: '',
    parents: ['p1', 'p2']
  }
}

describe('branchFromPrMergeSubject', () => {
  test('names the head branch, nested segments and all', () => {
    expect(
      branchFromPrMergeSubject('Merge pull request #89 from danipen/graph/squash-merged')
    ).toBe('graph/squash-merged')
  })

  test('ignores anything that is not a GitHub PR merge', () => {
    expect(branchFromPrMergeSubject("Merge branch 'feature'")).toBeNull()
    expect(branchFromPrMergeSubject('Fix the build (#12)')).toBeNull()
  })
})

describe('landedPrOf', () => {
  test('reads a merge commit: number from the subject, title from the body', () => {
    const pr = landedPrOf(
      commit('Merge pull request #89 from danipen/graph-squash', '\nDraw squash landings\n')
    )
    expect(pr).toEqual({ number: 89, title: 'Draw squash landings' })
  })

  test('falls back to the subject when a merge commit has no body', () => {
    expect(landedPrOf(commit('Merge pull request #7 from o/b'))).toEqual({
      number: 7,
      title: 'Merge pull request #7 from o/b'
    })
  })

  test('reads a squash commit: the trailing (#N) and the title before it', () => {
    expect(landedPrOf(commit('Add PR chips to the graph (#123)'))).toEqual({
      number: 123,
      title: 'Add PR chips to the graph'
    })
  })

  test('a (#N) anywhere but the end is just prose', () => {
    expect(landedPrOf(commit('Revert (#12) partially'))).toBeNull()
    expect(landedPrOf(commit('Plain commit'))).toBeNull()
  })

  test('tolerates CRLF bodies', () => {
    expect(landedPrOf(commit('Merge pull request #3 from o/b', '\r\nTitle here\r\n'))?.title).toBe(
      'Title here'
    )
  })
})
