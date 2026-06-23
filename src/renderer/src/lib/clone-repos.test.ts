import { describe, expect, it } from 'bun:test'
import type { RemoteRepo } from '@shared/types'
import { filterTerms, groupReposByOwner } from './clone-repos'

const repo = (owner: string, name: string, description: string | null = null): RemoteRepo => ({
  id: `github.com/${owner}/${name}`,
  host: 'github.com',
  owner,
  name,
  fullName: `${owner}/${name}`,
  cloneUrl: `https://github.com/${owner}/${name}.git`,
  private: false,
  fork: false,
  archived: false,
  description,
  pushedAt: 0
})

describe('groupReposByOwner', () => {
  const repos = [
    repo('danipen', 'gitgrove'),
    repo('acme', 'widgets'),
    repo('danipen', 'dotfiles'),
    repo('zeta', 'tools')
  ]

  it('floats the signed-in user first, then sorts owners alphabetically', () => {
    const groups = groupReposByOwner(repos, 'danipen', '')
    expect(groups.map((g) => g.owner)).toEqual(['danipen', 'acme', 'zeta'])
    // Within a group, repos are alphabetical by name.
    expect(groups[0].repos.map((r) => r.name)).toEqual(['dotfiles', 'gitgrove'])
  })

  it('matches the self group case-insensitively', () => {
    const groups = groupReposByOwner(repos, 'DaniPen', '')
    expect(groups[0].owner).toBe('danipen')
  })

  it('filters across owner/name with all terms required', () => {
    const groups = groupReposByOwner(repos, 'danipen', 'dani grove')
    expect(groups).toHaveLength(1)
    expect(groups[0].repos.map((r) => r.fullName)).toEqual(['danipen/gitgrove'])
  })

  it('an empty filter keeps everything', () => {
    expect(groupReposByOwner(repos, 'danipen', '   ')).toHaveLength(3)
  })

  it('matches against the description, not just owner/name', () => {
    const described = [repo('acme', 'widgets', 'A fast desktop git client')]
    const groups = groupReposByOwner(described, 'danipen', 'desktop git')
    expect(groups.map((g) => g.repos.map((r) => r.fullName))).toEqual([['acme/widgets']])
    // A term in neither name nor description excludes the repo.
    expect(groupReposByOwner(described, 'danipen', 'desktop nope')).toHaveLength(0)
  })
})

describe('filterTerms', () => {
  it('splits on whitespace, lowercases, and drops blanks', () => {
    expect(filterTerms('  Git   Grove ')).toEqual(['git', 'grove'])
    expect(filterTerms('   ')).toEqual([])
  })
})
