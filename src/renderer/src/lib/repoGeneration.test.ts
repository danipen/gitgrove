import { describe, expect, test } from 'bun:test'
import { createRepoGeneration } from './repoGeneration'

describe('createRepoGeneration', () => {
  test('a load that resolves before any switch is still current', async () => {
    const gen = createRepoGeneration()
    const writes: string[] = []
    // A loader for the just-opened repo captures the generation, then awaits.
    const captured = gen.next()
    await Promise.resolve() // the (fast) snapshot/branches fetch
    if (gen.isCurrent(captured)) writes.push('A')
    expect(writes).toEqual(['A'])
  })

  test('a load that resolves after a repo switch is detected as stale', async () => {
    const gen = createRepoGeneration()
    const writes: string[] = []
    // Open A; its slow load captures the generation and starts awaiting.
    const capturedA = gen.next()
    const slowLoadOfA = (async () => {
      await Promise.resolve()
      // By the time A's load resolves, the user has switched to B.
      if (gen.isCurrent(capturedA)) writes.push('A')
    })()
    gen.next() // switch to B before A's load returns
    await slowLoadOfA
    expect(writes).toEqual([]) // A's stale result is never written
  })

  test('A → B → A is still stale (a counter sees it, a path check would not)', () => {
    const gen = createRepoGeneration()
    const capturedA = gen.current() // A's load captures generation 0
    gen.next() // switch to B
    gen.next() // switch back to A
    // The path is A again, but A's original in-flight load is still superseded.
    expect(gen.isCurrent(capturedA)).toBe(false)
  })

  test('the active generation is what later loads capture', () => {
    const gen = createRepoGeneration()
    expect(gen.current()).toBe(0)
    expect(gen.next()).toBe(1)
    expect(gen.current()).toBe(1)
    expect(gen.isCurrent(1)).toBe(true)
    expect(gen.isCurrent(0)).toBe(false)
  })
})
