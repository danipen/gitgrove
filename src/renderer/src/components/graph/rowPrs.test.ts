import { describe, expect, test } from 'bun:test'
import type { PullRequestInfo } from '@shared/types'
import type { BranchPrs } from '@/lib/pr-order'
import type { GraphRow } from './layout'
import { isPrLookupRow, rowPullRequests } from './rowPrs'

const WEB = 'https://github.com/octocat/hello'

function row(chain: number, name: string, overrides: Partial<GraphRow> = {}): GraphRow {
  return {
    chain,
    index: chain,
    name,
    kind: 'branch',
    isHead: false,
    tipHash: `tip${chain}`,
    baseHash: null,
    upstreamHash: null,
    empty: false,
    color: 1,
    startColumn: 0,
    endColumn: 0,
    landedPr: null,
    ...overrides
  }
}

function hostPr(number: number, headBranch: string): PullRequestInfo {
  return {
    number,
    state: 'open',
    title: `PR ${number}`,
    url: `${WEB}/pull/${number}`,
    draft: false,
    headBranch,
    baseBranch: 'main',
    isCrossRepo: false,
    checks: 'success'
  }
}

const hosted = (entries: [string, PullRequestInfo[]][]): Map<string, BranchPrs> =>
  new Map(entries.map(([name, prs]) => [name, { prs, total: prs.length }]))

describe('rowPullRequests', () => {
  test('a named branch shows what the host knows about it', () => {
    const prs = rowPullRequests(
      [row(1, 'feature')],
      hosted([['feature', [hostPr(7, 'feature')]]]),
      WEB
    )
    expect(prs.get(1)?.prs.map((p) => p.number)).toEqual([7])
  })

  test('a deleted branch shows the merged PR its landing recorded, linked', () => {
    const deleted = row(2, 'fix/crash', {
      kind: 'unnamed',
      landedPr: { number: 42, title: 'Fix the crash' }
    })
    const pr = rowPullRequests([deleted], new Map(), WEB).get(2)?.prs[0]
    expect(pr).toMatchObject({
      number: 42,
      state: 'merged',
      title: 'Fix the crash',
      url: `${WEB}/pull/42`,
      checks: null
    })
  })

  test('the host answer wins over the history record', () => {
    const merged = row(1, 'feature', { landedPr: { number: 3, title: 'old' } })
    const prs = rowPullRequests([merged], hosted([['feature', [hostPr(9, 'feature')]]]), WEB)
    expect(prs.get(1)?.prs[0].number).toBe(9)
  })

  test('history fills in while the host has no PR for the branch', () => {
    const merged = row(1, 'feature', { landedPr: { number: 3, title: 'old' } })
    expect(rowPullRequests([merged], hosted([['feature', []]]), WEB).get(1)?.prs[0].number).toBe(3)
  })

  test('an unnamed row never borrows a live branch of the same name', () => {
    const deleted = row(1, 'feature', { kind: 'unnamed' })
    const prs = rowPullRequests([deleted], hosted([['feature', [hostPr(9, 'feature')]]]), WEB)
    expect(prs.has(1)).toBe(false)
  })

  test('off GitHub, nothing gets a chip', () => {
    const merged = row(1, 'feature', { landedPr: { number: 3, title: 'old' } })
    expect(rowPullRequests([merged], new Map(), null).size).toBe(0)
  })
})

describe('isPrLookupRow', () => {
  test('only rows naming a real ref are looked up on the host', () => {
    expect(isPrLookupRow(row(1, 'a'))).toBe(true)
    expect(isPrLookupRow(row(1, 'a', { kind: 'remote' }))).toBe(true)
    expect(isPrLookupRow(row(1, 'a', { kind: 'unnamed' }))).toBe(false)
    expect(isPrLookupRow(row(1, 'HEAD', { kind: 'detached' }))).toBe(false)
  })
})
