import { describe, expect, test } from 'bun:test'
import type { PullRequestInfo } from '@shared/types'
import { groupPrsByBranch, prRank } from './pr-order'

const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 1,
  state: 'open',
  title: 'PR',
  url: 'https://example/pull/1',
  draft: false,
  headBranch: 'feature',
  baseBranch: 'main',
  isCrossRepo: false,
  checks: null,
  ...over
})

describe('prRank', () => {
  test('orders open < draft < merged < closed', () => {
    expect(prRank(pr({ state: 'open', draft: false }))).toBe(0)
    expect(prRank(pr({ state: 'open', draft: true }))).toBe(1)
    expect(prRank(pr({ state: 'merged' }))).toBe(2)
    expect(prRank(pr({ state: 'closed' }))).toBe(3)
  })
})

describe('groupPrsByBranch', () => {
  test('groups by head branch and orders each by importance', () => {
    const merged = pr({ number: 1, state: 'merged' })
    const open = pr({ number: 2, state: 'open' })
    const draft = pr({ number: 3, state: 'open', draft: true })
    const grouped = groupPrsByBranch([merged, open, draft])
    expect(grouped.get('feature')?.map((p) => p.number)).toEqual([2, 3, 1])
  })

  test('keeps most-recent-first order within the same state (stable)', () => {
    // Input order is the API order (most recently updated first).
    const newer = pr({ number: 5, state: 'merged' })
    const older = pr({ number: 4, state: 'merged' })
    expect(
      groupPrsByBranch([newer, older])
        .get('feature')
        ?.map((p) => p.number)
    ).toEqual([5, 4])
  })

  test('separates branches', () => {
    const a = pr({ number: 1, headBranch: 'a' })
    const b = pr({ number: 2, headBranch: 'b' })
    const grouped = groupPrsByBranch([a, b])
    expect(grouped.get('a')?.map((p) => p.number)).toEqual([1])
    expect(grouped.get('b')?.map((p) => p.number)).toEqual([2])
  })

  test('drops cross-repo PRs (fork head refs are ambiguous)', () => {
    const own = pr({ number: 1 })
    const fork = pr({ number: 2, isCrossRepo: true })
    expect(
      groupPrsByBranch([own, fork])
        .get('feature')
        ?.map((p) => p.number)
    ).toEqual([1])
  })
})
