import { describe, expect, it } from 'bun:test'
import type { BlameLine } from '@shared/types'
import {
  BLAME_LINE_HEIGHT,
  blameWindow,
  canReblame,
  isRunStart,
  popReblame,
  pushReblame
} from './blame'

const line = (over: Partial<BlameLine>): BlameLine => ({
  hash: 'a'.repeat(40),
  shortHash: 'aaaaaaa',
  authorName: 'Dana',
  authorEmail: 'dana@example.com',
  date: '2026-01-01T00:00:00.000Z',
  summary: 'change',
  lineNumber: 1,
  content: 'x',
  filename: 'file.txt',
  ...over
})

describe('blameWindow', () => {
  it('is empty when there is nothing to show', () => {
    expect(blameWindow(0, 0, 100)).toEqual({ start: 0, end: 0 })
    expect(blameWindow(0, 400, 0)).toEqual({ start: 0, end: 0 })
  })

  it('covers the visible rows plus overscan, clamped to the line count', () => {
    const h = BLAME_LINE_HEIGHT
    // Scrolled 50 rows down, 20-row viewport, 1000 lines, overscan 6.
    const win = blameWindow(50 * h, 20 * h, 1000, 6)
    expect(win.start).toBe(44) // 50 - 6
    expect(win.end).toBe(76) // 50 + 20 + 6
  })

  it('never runs past the ends', () => {
    const h = BLAME_LINE_HEIGHT
    expect(blameWindow(0, 10 * h, 5).start).toBe(0)
    expect(blameWindow(0, 10 * h, 5).end).toBe(5)
    const tail = blameWindow(1000 * h, 10 * h, 1000)
    expect(tail.end).toBe(1000)
    expect(tail.start).toBeGreaterThanOrEqual(0)
  })
})

describe('isRunStart', () => {
  const lines = [
    line({ hash: 'a'.repeat(40) }),
    line({ hash: 'a'.repeat(40) }),
    line({ hash: 'b'.repeat(40) })
  ]
  it('starts a run at index 0', () => expect(isRunStart(lines, 0)).toBe(true))
  it('continues a run for the same commit', () => expect(isRunStart(lines, 1)).toBe(false))
  it('starts a new run when the commit changes', () => expect(isRunStart(lines, 2)).toBe(true))
})

describe('canReblame', () => {
  it('needs a prior version', () => {
    expect(canReblame(line({}))).toBe(false)
    expect(canReblame(line({ previous: { hash: 'b'.repeat(40), filename: 'file.txt' } }))).toBe(
      true
    )
  })
  it('excludes uncommitted lines even with a previous', () => {
    expect(
      canReblame(
        line({ notCommitted: true, previous: { hash: 'b'.repeat(40), filename: 'file.txt' } })
      )
    ).toBe(false)
  })
})

describe('reblame stack', () => {
  const base = [{ ref: null, path: 'file.txt', label: 'working tree' }]

  it('pushes the line’s parent revision and path', () => {
    const next = pushReblame(
      base,
      line({ previous: { hash: 'b'.repeat(40), filename: 'old.txt' } })
    )
    expect(next).toHaveLength(2)
    expect(next[1]).toEqual({ ref: 'b'.repeat(40), path: 'old.txt', label: 'bbbbbbb' })
  })

  it('is a no-op for non-reblameable lines', () => {
    expect(pushReblame(base, line({ notCommitted: true }))).toBe(base)
  })

  it('pops back but never removes the initial frame', () => {
    const two = pushReblame(base, line({ previous: { hash: 'c'.repeat(40), filename: 'f' } }))
    expect(popReblame(two)).toHaveLength(1)
    expect(popReblame(base)).toBe(base)
  })
})
