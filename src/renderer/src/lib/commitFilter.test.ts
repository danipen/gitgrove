import { describe, expect, it } from 'bun:test'
import type { Commit } from '@shared/types'
import { filterCommits, filterTerms } from './commitFilter'

function commit(subject: string, authorName: string): Commit {
  return {
    hash: subject,
    shortHash: subject.slice(0, 7),
    subject,
    body: '',
    authorName,
    authorEmail: `${authorName}@example.com`,
    date: '',
    relativeDate: '',
    refs: '',
    parents: []
  }
}

const commits = [
  commit('Fix the editor crash', 'Ada Lovelace'),
  commit('Add history filter', 'Grace Hopper'),
  commit('Refactor editor toolbar', 'Ada Lovelace')
]

describe('filterTerms', () => {
  it('lowercases and splits on whitespace, dropping empties', () => {
    expect(filterTerms('  Fix  Editor ')).toEqual(['fix', 'editor'])
  })

  it('is empty for a blank query', () => {
    expect(filterTerms('   ')).toEqual([])
  })
})

describe('filterCommits', () => {
  it('returns the input array for a blank query', () => {
    expect(filterCommits(commits, '   ')).toBe(commits)
  })

  it('matches the subject case-insensitively', () => {
    expect(filterCommits(commits, 'EDITOR').map((c) => c.subject)).toEqual([
      'Fix the editor crash',
      'Refactor editor toolbar'
    ])
  })

  it('matches the author name', () => {
    expect(filterCommits(commits, 'grace').map((c) => c.subject)).toEqual(['Add history filter'])
  })

  it('requires every term to match (across subject and author)', () => {
    // "editor" is in two subjects, but only one is also by "ada"... both are;
    // narrow with a subject word to prove the AND.
    expect(filterCommits(commits, 'ada toolbar').map((c) => c.subject)).toEqual([
      'Refactor editor toolbar'
    ])
  })

  it('yields nothing when a term matches no commit', () => {
    expect(filterCommits(commits, 'nonexistent')).toEqual([])
  })
})
