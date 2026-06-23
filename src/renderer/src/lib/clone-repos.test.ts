import { describe, expect, it } from 'bun:test'
import type { RemoteRepo } from '@shared/types'
import { groupReposByOwner } from './clone-repos'

const repo = (owner: string, name: string): RemoteRepo => ({
  id: `github.com/${owner}/${name}`,
  host: 'github.com',
  owner,
  name,
  fullName: `${owner}/${name}`,
  cloneUrl: `https://github.com/${owner}/${name}.git`,
  private: false,
  fork: false,
  archived: false,
  description: null,
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
    expect(groups[0].repos.map((r) => r.name)).toEqual(['gitgrove', 'dotfiles'])
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
})
