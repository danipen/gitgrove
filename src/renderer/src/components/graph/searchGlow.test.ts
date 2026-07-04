import { describe, expect, test } from 'bun:test'
import { litChains, pingRings, withAlpha } from './searchGlow'

describe('pingRings', () => {
  test('settled pulse draws nothing', () => {
    expect(pingRings(1)).toEqual([])
    expect(pingRings(1.5)).toEqual([])
  })

  test('out-of-range pulse draws nothing', () => {
    expect(pingRings(-0.1)).toEqual([])
  })

  test('launch moment: only the first ring, at the start radius', () => {
    const rings = pingRings(0.01)
    expect(rings.length).toBe(1)
    expect(rings[0].grow).toBeLessThan(1)
    expect(rings[0].alpha).toBeGreaterThan(0.6)
  })

  test('mid-ping: both staggered rings, the older one further out and fainter', () => {
    const rings = pingRings(0.6)
    expect(rings.length).toBe(2)
    const [first, second] = rings
    expect(first.grow).toBeGreaterThan(second.grow)
    expect(first.alpha).toBeLessThan(second.alpha)
  })

  test('rings expand and fade monotonically over the pulse', () => {
    let lastGrow = -1
    let lastAlpha = 2
    for (const pulse of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const first = pingRings(pulse)[0]
      expect(first.grow).toBeGreaterThan(lastGrow)
      expect(first.alpha).toBeLessThan(lastAlpha)
      lastGrow = first.grow
      lastAlpha = first.alpha
    }
  })
})

describe('withAlpha', () => {
  test('expands #rrggbb tokens', () => {
    expect(withAlpha('#d6a027', 0.5)).toBe('rgba(214, 160, 39, 0.5)')
  })

  test('expands #rgb shorthand', () => {
    expect(withAlpha('#f00', 0.25)).toBe('rgba(255, 0, 0, 0.25)')
  })

  test('zero alpha is honored (transparent gradient stop)', () => {
    expect(withAlpha('#9a6700', 0)).toBe('rgba(154, 103, 0, 0)')
  })

  test('non-hex colors pass through untouched', () => {
    expect(withAlpha('hsl(214 72% 64%)', 0.5)).toBe('hsl(214 72% 64%)')
  })

  test('cached calls stay stable', () => {
    expect(withAlpha('#d6a027', 0.5)).toBe(withAlpha('#d6a027', 0.5))
  })
})

describe('litChains', () => {
  const node = (chain: number, hash: string) => ({ chain, commit: { hash } })

  test('collects only chains holding a match', () => {
    const nodes = [node(0, 'a'), node(0, 'b'), node(1, 'c'), node(2, 'd')]
    const lit = litChains(nodes, new Set(['b', 'd']))
    expect(lit.has(0)).toBe(true)
    expect(lit.has(1)).toBe(false)
    expect(lit.has(2)).toBe(true)
  })

  test('no matches lights nothing (every label ghosts)', () => {
    const nodes = [node(0, 'a'), node(1, 'b')]
    expect(litChains(nodes, new Set()).size).toBe(0)
  })
})
