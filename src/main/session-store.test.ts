import { describe, expect, test } from 'bun:test'
import { parseSession } from './session-store'

describe('parseSession', () => {
  test('keeps repo paths and welcome-screen markers in window order', () => {
    expect(parseSession(['/repos/a', null, '/repos/b'])).toEqual(['/repos/a', null, '/repos/b'])
  })

  test('drops entries that are neither a path nor null', () => {
    expect(parseSession(['/repos/a', 42, undefined, {}, '', '/repos/b'])).toEqual([
      '/repos/a',
      '/repos/b'
    ])
  })

  test('caps a ballooned session', () => {
    const huge = Array.from({ length: 50 }, (_, i) => `/repos/${i}`)
    expect(parseSession(huge)).toHaveLength(20)
  })

  test.each([
    ['not an array', { windows: ['/repos/a'] }],
    ['a string', '/repos/a'],
    ['null', null],
    ['a number', 7]
  ])('degrades to an empty session on %s', (_label, raw) => {
    expect(parseSession(raw)).toEqual([])
  })
})
