import { describe, expect, test } from 'bun:test'
import type { BranchInfo, RepoHostInfo, SyncStatus } from '@shared/types'
import { createPrBannerUrl } from './pr-banner'

const github: RepoHostInfo = { provider: 'github', webUrl: 'https://github.com/o/r' }

const branch = (over: Partial<BranchInfo> = {}): BranchInfo => ({
  current: 'feature',
  detached: false,
  local: ['main', 'feature'],
  remote: ['origin/main', 'origin/feature'],
  defaultBranch: 'main',
  recent: [],
  ...over
})

const sync = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  upstream: 'origin/feature',
  ahead: 0,
  behind: 0,
  remotes: ['origin'],
  ...over
})

const call = (over: Partial<Parameters<typeof createPrBannerUrl>[0]> = {}) =>
  createPrBannerUrl({
    prsLoaded: true,
    hostInfo: github,
    branch: branch(),
    sync: sync(),
    branchesWithPrs: new Set<string>(),
    ...over
  })

describe('createPrBannerUrl', () => {
  test('offers a compare URL for a published feature branch with no PR', () => {
    expect(call()).toBe('https://github.com/o/r/compare/main...feature?expand=1')
  })

  test('hides until PRs have loaded', () => {
    expect(call({ prsLoaded: false })).toBeNull()
  })

  test('hides off GitHub hosts', () => {
    expect(call({ hostInfo: { provider: null, webUrl: null } })).toBeNull()
    expect(call({ hostInfo: { provider: 'github', webUrl: null } })).toBeNull()
  })

  test('hides on the default branch itself', () => {
    expect(call({ branch: branch({ current: 'main' }) })).toBeNull()
  })

  test('hides when detached or the default branch is unknown', () => {
    expect(call({ branch: branch({ detached: true }) })).toBeNull()
    expect(call({ branch: branch({ defaultBranch: null }) })).toBeNull()
  })

  test('hides when the branch has no upstream', () => {
    expect(call({ sync: sync({ upstream: null }) })).toBeNull()
  })

  test('hides when the configured upstream no longer exists on the remote', () => {
    // A stale local `master` tracking a deleted origin/master (the remote
    // renamed its default to main): git still reports the configured upstream,
    // but there's nothing on the remote to open a PR from.
    expect(
      call({
        branch: branch({ current: 'master', remote: ['origin/main'] }),
        sync: sync({ upstream: 'origin/master' })
      })
    ).toBeNull()
  })

  test('hides when the branch already carries a PR of any kind', () => {
    expect(call({ branchesWithPrs: new Set(['feature']) })).toBeNull()
  })
})
