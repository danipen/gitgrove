import { describe, expect, test } from 'bun:test'
import { branchPullsUrl, branchUrl, commitUrl, compareUrl, parseOwnerRepo } from './git-host-urls'

const BASE = 'https://github.com/octocat/hello'

describe('commitUrl', () => {
  test('builds the commit page url', () => {
    expect(commitUrl(BASE, 'abc123')).toBe('https://github.com/octocat/hello/commit/abc123')
  })

  test('tolerates a trailing slash on the base', () => {
    expect(commitUrl(`${BASE}/`, 'abc123')).toBe('https://github.com/octocat/hello/commit/abc123')
  })
})

describe('branchUrl', () => {
  test('builds the tree page url', () => {
    expect(branchUrl(BASE, 'main')).toBe('https://github.com/octocat/hello/tree/main')
  })

  test('percent-encodes slashes and special chars in the branch ref', () => {
    expect(branchUrl(BASE, 'feature/new thing')).toBe(
      'https://github.com/octocat/hello/tree/feature%2Fnew%20thing'
    )
  })
})

describe('branchPullsUrl', () => {
  test('links to the PR list filtered by head ref (all states)', () => {
    expect(branchPullsUrl(BASE, 'feature/x')).toBe(
      'https://github.com/octocat/hello/pulls?q=head%3Afeature%2Fx'
    )
  })
})

describe('compareUrl', () => {
  test('builds an expanded compare url between two branches', () => {
    expect(compareUrl(BASE, 'main', 'feature')).toBe(
      'https://github.com/octocat/hello/compare/main...feature?expand=1'
    )
  })

  test('encodes both refs without touching the ... separator', () => {
    expect(compareUrl(BASE, 'release/1.0', 'feature/x')).toBe(
      'https://github.com/octocat/hello/compare/release%2F1.0...feature%2Fx?expand=1'
    )
  })
})

describe('parseOwnerRepo', () => {
  test('splits owner and repo from a web url', () => {
    expect(parseOwnerRepo('https://github.com/octocat/hello')).toEqual({
      owner: 'octocat',
      repo: 'hello'
    })
  })

  test('strips a trailing .git and ignores a trailing slash', () => {
    expect(parseOwnerRepo('https://github.com/octocat/hello.git/')).toEqual({
      owner: 'octocat',
      repo: 'hello'
    })
  })

  test('works for GitHub Enterprise hosts', () => {
    expect(parseOwnerRepo('https://github.example.com/team/project')).toEqual({
      owner: 'team',
      repo: 'project'
    })
  })

  test('takes the first two segments when the path is deeper', () => {
    expect(parseOwnerRepo('https://github.com/octocat/hello/tree/main')).toEqual({
      owner: 'octocat',
      repo: 'hello'
    })
  })

  test('returns null when there is no owner/repo pair', () => {
    expect(parseOwnerRepo('https://github.com/octocat')).toBeNull()
    expect(parseOwnerRepo('not a url')).toBeNull()
  })
})
