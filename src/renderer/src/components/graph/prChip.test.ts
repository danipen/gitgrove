import { describe, expect, test } from 'bun:test'
import type { PullRequestInfo } from '@shared/types'
import { ciPulseAlpha, mixHex, onAccentStates, prChipGlyph } from './prChip'

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

describe('mixHex', () => {
  test('blends two colors channel by channel', () => {
    expect(mixHex('#ff0000', '#0000ff', 1)).toBe('#ff0000')
    expect(mixHex('#ff0000', '#0000ff', 0)).toBe('#0000ff')
    expect(mixHex('#ff0000', '#ffffff', 0.5)).toBe('#ff8080')
  })

  test('reads the short form and falls back to the second color', () => {
    expect(mixHex('#f00', '#fff', 0.5)).toBe('#ff8080')
    expect(mixHex('red', '#ffffff', 0.5)).toBe('#ffffff')
  })
})

describe('onAccentStates', () => {
  test('pulls every state hue toward the accent pill ink', () => {
    const states = { success: '#1a7f37', failure: '#cf222e', pending: '#9a6700', merged: '#8250df' }
    const tuned = onAccentStates(states, '#ffffff')
    for (const key of ['success', 'failure', 'pending', 'merged'] as const) {
      expect(tuned[key]).toBe(mixHex(states[key], '#ffffff', 0.45))
      expect(tuned[key]).not.toBe(states[key])
    }
  })
})
