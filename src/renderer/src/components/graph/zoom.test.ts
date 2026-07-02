import { describe, expect, test } from 'bun:test'
import { MAX_SCALE, MIN_SCALE } from './geometry'
import {
  accumulateZoom,
  cubicEaseOut,
  isDiscreteWheel,
  wheelZoomFactor,
  ZOOM_ANIM_MAX_MS,
  ZOOM_ANIM_MS
} from './zoom'

describe('cubicEaseOut', () => {
  test('starts at 0 and lands at 1', () => {
    expect(cubicEaseOut(0)).toBe(0)
    expect(cubicEaseOut(1)).toBe(1)
  })

  test('is monotonic and front-loaded (fast start, gentle landing)', () => {
    let prev = 0
    for (let t = 0.1; t <= 1.001; t += 0.1) {
      const v = cubicEaseOut(t)
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
    expect(cubicEaseOut(0.5)).toBeGreaterThan(0.5)
  })
})

describe('isDiscreteWheel', () => {
  test('classifies a physical wheel notch (pixel mode, ~100px) as discrete', () => {
    expect(isDiscreteWheel(-100, 0)).toBe(true)
    expect(isDiscreteWheel(120, 0)).toBe(true)
  })

  test('classifies trackpad pinch deltas (small, fractional) as continuous', () => {
    expect(isDiscreteWheel(-3.5, 0)).toBe(false)
    expect(isDiscreteWheel(12, 0)).toBe(false)
  })

  test('line and page modes only come from real wheels', () => {
    expect(isDiscreteWheel(-3, 1)).toBe(true)
    expect(isDiscreteWheel(1, 2)).toBe(true)
  })
})

describe('wheelZoomFactor', () => {
  test('spin up zooms in, spin down zooms out, symmetrically', () => {
    const zoomIn = wheelZoomFactor(-100, 0)
    const zoomOut = wheelZoomFactor(100, 0)
    expect(zoomIn).toBeGreaterThan(1)
    expect(zoomOut).toBeLessThan(1)
    expect(zoomIn * zoomOut).toBeCloseTo(1)
  })

  test('accelerated multi-notch deltas zoom harder, but capped', () => {
    const single = wheelZoomFactor(-100, 0)
    const triple = wheelZoomFactor(-300, 0)
    const extreme = wheelZoomFactor(-10000, 0)
    expect(triple).toBeGreaterThan(single)
    expect(extreme).toBe(1 / 0.5) // MAX_SENSITIVITY ceiling
  })

  test('line mode counts 3 lines as one notch', () => {
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-100, 0))
  })
})

describe('accumulateZoom', () => {
  const IN = wheelZoomFactor(-100, 0)
  const OUT = wheelZoomFactor(100, 0)

  test('first notch targets current scale × factor with the base duration', () => {
    const m = accumulateZoom(null, 1, IN, 1000)
    expect(m.target).toBeCloseTo(IN)
    expect(m.direction).toBe(1)
    expect(m.startedAt).toBe(1000)
    expect(m.duration).toBe(ZOOM_ANIM_MS)
  })

  test('same-direction notch mid-flight compounds the target', () => {
    const first = accumulateZoom(null, 1, IN, 1000)
    const second = accumulateZoom(first, 1.05, IN, 1100)
    // Builds on the previous TARGET, not the live (mid-animation) scale.
    expect(second.target).toBeCloseTo(IN * IN)
  })

  test('spinning mid-flight extends the glide (momentum), capped at the max', () => {
    const first = accumulateZoom(null, 1, IN, 1000)
    // 150ms in, 50ms unspent → the unspent time is added back: 250ms glide…
    const second = accumulateZoom(first, 1.05, IN, 1150)
    expect(second.duration).toBe(ZOOM_ANIM_MS + 50)
    // …and further spinning can't push it past the ceiling.
    const third = accumulateZoom(second, 1.08, IN, 1200)
    expect(third.duration).toBe(ZOOM_ANIM_MAX_MS)
  })

  test('a notch after the glide finished starts a fresh clock from the old target', () => {
    const first = accumulateZoom(null, 1, IN, 1000)
    const later = accumulateZoom(first, first.target, IN, 1000 + ZOOM_ANIM_MS + 500)
    expect(later.target).toBeCloseTo(first.target * IN)
    expect(later.duration).toBe(ZOOM_ANIM_MS)
  })

  test('reversing direction abandons the old target and starts from the live scale', () => {
    const zoomingIn = accumulateZoom(null, 1, IN, 1000)
    const reversed = accumulateZoom(zoomingIn, 1.05, OUT, 1100)
    expect(reversed.target).toBeCloseTo(1.05 * OUT)
    expect(reversed.direction).toBe(-1)
    expect(reversed.duration).toBe(ZOOM_ANIM_MS)
  })

  test('target clamps to the scale bounds', () => {
    const atMax = accumulateZoom(null, MAX_SCALE, IN, 0)
    expect(atMax.target).toBe(MAX_SCALE)
    const atMin = accumulateZoom(null, MIN_SCALE, OUT, 0)
    expect(atMin.target).toBe(MIN_SCALE)
  })
})
