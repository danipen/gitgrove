import { describe, expect, it } from 'bun:test'
import { appCommand } from '@shared/commands'
import type { ChangedFile, Commit, RefEntry, StashEntry } from '@shared/types'
import {
  buildSections,
  COLLAPSED_ROWS,
  looksLikeCommitId,
  type PaletteSources,
  parseScope,
  type SectionId
} from './paletteResults'

const ref = (kind: RefEntry['kind'], name: string, date = 0): RefEntry => ({
  kind,
  name,
  hash: 'a'.repeat(40),
  date
})

const change = (path: string): ChangedFile => ({ path, status: 'modified', staged: false })

const commit: Commit = {
  hash: 'abcdef1234567890abcdef1234567890abcdef12',
  shortHash: 'abcdef1',
  subject: 'Fix it',
  body: '',
  authorName: 'A',
  authorEmail: 'a@example.com',
  date: '2026-01-01T00:00:00Z',
  relativeDate: 'today',
  refs: '',
  parents: []
}

const stash: StashEntry = {
  index: 0,
  sha: 'f'.repeat(40),
  message: 'wip on login form',
  branchName: 'main',
  auto: false,
  relativeDate: 'today'
} as StashEntry

function sources(overrides: Partial<PaletteSources> = {}): PaletteSources {
  return {
    commands: [
      { command: appCommand('fetch'), title: 'Fetch', accelerator: null },
      { command: appCommand('new-branch'), title: 'New Branch…', accelerator: null }
    ],
    refs: [
      ref('local', 'feature/login', 3),
      ref('local', 'main', 2),
      ref('remote', 'origin/main', 2),
      ref('tag', 'v1.0.0', 1)
    ],
    currentBranch: 'main',
    changes: [change('src/login.ts')],
    fileMatches: [],
    filesLoading: false,
    stashes: [stash],
    worktrees: [],
    repos: [],
    currentRepoPath: '/repo',
    commit: null,
    ...overrides
  }
}

const none = new Set<SectionId>()
const ids = (s: PaletteSources, q: string) => buildSections(s, q, none).map((x) => x.id)
const keys = (s: PaletteSources, q: string, id: SectionId) =>
  buildSections(s, q, none)
    .find((x) => x.id === id)
    ?.hits.map((h) => h.key) ?? []

describe('parseScope', () => {
  it('narrows by a leading prefix', () => {
    expect(parseScope('>fetch')).toEqual({ scope: 'commands', text: 'fetch' })
    expect(parseScope('  @main')).toEqual({ scope: 'refs', text: 'main' })
    expect(parseScope('/app')).toEqual({ scope: 'files', text: 'app' })
    expect(parseScope('main')).toEqual({ scope: 'all', text: 'main' })
  })
})

describe('looksLikeCommitId', () => {
  it('accepts 7 to 40 hex digits only', () => {
    expect(looksLikeCommitId('abcdef1')).toBe(true)
    expect(looksLikeCommitId('abcdef')).toBe(false)
    expect(looksLikeCommitId('abcdefg')).toBe(false)
  })
})

describe('buildSections', () => {
  it('orders sections the same way every time and drops empty ones', () => {
    expect(ids(sources(), 'main')).toEqual(['branches'])
    expect(ids(sources(), 'login')).toEqual(['branches', 'files', 'stashes'])
  })

  it('lists local branches with the current one first when the query is empty', () => {
    expect(keys(sources(), '', 'branches')).toEqual([
      'branch:local:main',
      'branch:local:feature/login'
    ])
  })

  it('keeps tags out of the unfiltered view and finds them once searched', () => {
    expect(ids(sources(), '')).not.toContain('tags')
    expect(keys(sources(), 'v1', 'tags')).toEqual(['tag:tag:v1.0.0'])
  })

  it('scopes to one kind of thing with a prefix', () => {
    expect(ids(sources(), '>fetch')).toEqual(['commands'])
    expect(ids(sources(), '@main')).toEqual(['branches'])
    expect(ids(sources(), '/login')).toEqual(['files'])
  })

  it('merges changed files with main matches, each path once', () => {
    const s = sources({
      fileMatches: [
        { path: 'src/login.ts', score: 1, positions: [] },
        { path: 'docs/login.md', score: 1, positions: [] }
      ]
    })
    const files = buildSections(s, 'login', none).find((x) => x.id === 'files')!
    expect(files.hits.map((h) => h.key).sort()).toEqual(['file:docs/login.md', 'file:src/login.ts'])
    const changed = files.hits.find((h) => h.key === 'file:src/login.ts')!
    expect(changed.item.kind === 'file' && changed.item.change?.status).toBe('modified')
  })

  it('shows a loading section while files are being searched', () => {
    const files = buildSections(sources({ filesLoading: true, changes: [] }), 'zzz', none)
    expect(files.map((x) => [x.id, x.loading])).toEqual([['files', true]])
  })

  it('caps a section until it is expanded', () => {
    const many = Array.from({ length: 12 }, (_, i) => ref('local', `topic-${i}`))
    const s = sources({ refs: many })
    const collapsed = buildSections(s, 'topic', none).find((x) => x.id === 'branches')!
    expect(collapsed.hits).toHaveLength(COLLAPSED_ROWS)
    expect(collapsed.more).toBe(12 - COLLAPSED_ROWS)
    const open = buildSections(s, 'topic', new Set(['branches'])).find((x) => x.id === 'branches')!
    expect(open.hits).toHaveLength(12)
    expect(open.more).toBe(0)
  })

  it('offers a pasted commit id first', () => {
    const s = sources({ commit })
    expect(ids(s, 'ABCDEF12')[0]).toBe('commit')
    const hit = buildSections(s, 'abcdef12', none)[0].hits[0]
    expect(hit.highlights).toEqual([[0, 1, 2, 3, 4, 5, 6]])
    // A stale lookup for another id never shows.
    expect(ids(s, '1234567')).not.toContain('commit')
  })

  it('highlights the matched characters of each field', () => {
    const hit = buildSections(sources(), 'fetch', none)[0].hits[0]
    expect(hit.highlights).toEqual([[0, 1, 2, 3, 4]])
  })

  it('never offers the open repo or the current worktree as a place to go', () => {
    const s = sources({
      repos: [
        { path: '/repo', name: 'repo', lastOpened: 1, missing: false },
        { path: '/other', name: 'other', lastOpened: 1, missing: false },
        { path: '/gone', name: 'gone', lastOpened: 1, missing: true }
      ],
      worktrees: [
        { path: '/repo', branch: 'main', headShort: 'a', isMain: true, isCurrent: true },
        { path: '/wt', branch: 'hotfix', headShort: 'b', isMain: false, isCurrent: false }
      ]
    })
    expect(keys(s, '', 'repos')).toEqual(['repo:/other'])
    expect(keys(s, '', 'worktrees')).toEqual(['worktree:/wt'])
  })
})
