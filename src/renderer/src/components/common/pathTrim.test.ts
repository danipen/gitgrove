import { describe, expect, test } from 'bun:test'
import { ELLIPSIS, trimDirToFit } from './pathTrim'

// 10px per code point, so widths are trivial to reason about in the cases.
const measure = (text: string) => Array.from(text).length * 10

describe('trimDirToFit', () => {
  test('returns the dir untouched when it already fits', () => {
    expect(trimDirToFit('src/lib/', 80, measure)).toBe('src/lib/')
    expect(trimDirToFit('src/lib/', 200, measure)).toBe('src/lib/')
  })

  test('cuts to the longest prefix that fits with the ellipsis', () => {
    // 5 slots: 4 chars + the ellipsis.
    expect(trimDirToFit('src/lib/deep/', 50, measure)).toBe(`src/${ELLIPSIS}`)
  })

  test('an exact fit is not trimmed', () => {
    expect(trimDirToFit('src/lib/', 80, measure)).toBe('src/lib/')
  })

  test('one pixel short of an exact fit gives up the ellipsis room too', () => {
    // 79px fits 7 slots: 6 characters plus the ellipsis.
    expect(trimDirToFit('src/lib/', 79, measure)).toBe(`src/li${ELLIPSIS}`)
  })

  test('returns just the ellipsis when only it fits', () => {
    expect(trimDirToFit('src/', 10, measure)).toBe(ELLIPSIS)
  })

  test('returns nothing when not even the ellipsis fits', () => {
    expect(trimDirToFit('src/', 9, measure)).toBe('')
    expect(trimDirToFit('src/', -5, measure)).toBe('')
  })

  test('empty dir stays empty', () => {
    expect(trimDirToFit('', 100, measure)).toBe('')
    expect(trimDirToFit('', 0, measure)).toBe('')
  })

  test('never splits a surrogate pair', () => {
    // "📁" is two UTF-16 units but one code point (one 10px slot here). With
    // room for two slots the cut lands after the emoji, never inside it.
    const trimmed = trimDirToFit('a📁b/', 30, measure)
    expect(trimmed).toBe(`a📁${ELLIPSIS}`)
  })

  test('matches a linear search for every width', () => {
    const dir = 'Modules/AssetBundle/Tests/'
    for (let max = 0; max <= measure(dir) + 10; max++) {
      const fast = trimDirToFit(dir, max, measure)
      let slow = ''
      if (measure(dir) <= max) slow = dir
      else if (measure(ELLIPSIS) <= max) {
        const chars = Array.from(dir)
        let n = 0
        while (n < chars.length && measure(chars.slice(0, n + 1).join('') + ELLIPSIS) <= max) n++
        slow = chars.slice(0, n).join('') + ELLIPSIS
      }
      expect(fast).toBe(slow)
    }
  })
})
