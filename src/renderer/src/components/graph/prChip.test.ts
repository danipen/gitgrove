import { describe, expect, test } from 'bun:test'
import type { PullRequestInfo } from '@shared/types'
import { ciPulseAlpha, prChipGlyph } from './prChip'

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
    expect(prChipGlyph(pr({ checks: null }))).toBeNull()
  })

  test('a draft shows its CI once checks run, the draft octicon before', () => {
    expect(prChipGlyph(pr({ draft: true, checks: 'failure' }))).toBe('failure')
    expect(prChipGlyph(pr({ draft: true, checks: null }))).toBe('draft')
  })

  test('a settled PR leads with its state octicon, never stale CI', () => {
    expect(prChipGlyph(pr({ state: 'merged', checks: 'failure' }))).toBe('merged')
    expect(prChipGlyph(pr({ state: 'closed' }))).toBe('closed')
  })
})

describe('ciPulseAlpha', () => {
  test('breathes 1 → 0.35 → 1 over the badge pulse period', () => {
    expect(ciPulseAlpha(0)).toBeCloseTo(1)
    expect(ciPulseAlpha(650)).toBeCloseTo(0.35)
    expect(ciPulseAlpha(1300)).toBeCloseTo(1)
  })

  test('stays within the keyframe range at every phase', () => {
    for (let ms = 0; ms < 2600; ms += 37) {
      const alpha = ciPulseAlpha(ms)
      expect(alpha).toBeGreaterThanOrEqual(0.35 - 1e-9)
      expect(alpha).toBeLessThanOrEqual(1)
    }
  })
})
