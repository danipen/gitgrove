import { describe, expect, test } from 'bun:test'
import type { PullRequestInfo } from '@shared/types'
import { prChipGlyph } from './prChip'

function pr(overrides: Partial<PullRequestInfo>): PullRequestInfo {
  return {
    number: 1,
    state: 'open',
    title: 't',
    url: 'u',
    draft: false,
    headBranch: 'b',
    baseBranch: 'main',
    isCrossRepo: false,
    checks: null,
    ...overrides
  }
}

describe('prChipGlyph', () => {
  test('an open PR leads with its CI rollup, or nothing when no checks ran', () => {
    expect(prChipGlyph(pr({ checks: 'success' }))).toBe('success')
    expect(prChipGlyph(pr({ checks: 'failure' }))).toBe('failure')
    expect(prChipGlyph(pr({ checks: 'pending' }))).toBe('pending')
    expect(prChipGlyph(pr({ checks: null, draft: true }))).toBeNull()
  })

  test('a settled PR leads with its state octicon, never stale CI', () => {
    expect(prChipGlyph(pr({ state: 'merged', checks: 'failure' }))).toBe('merged')
    expect(prChipGlyph(pr({ state: 'closed' }))).toBe('closed')
  })
})
