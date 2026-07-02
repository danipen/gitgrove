import { describe, expect, test } from 'bun:test'
import {
  decayFling,
  FLING_MIN_LAUNCH,
  FLING_MIN_SPEED,
  flingVelocity,
  type PanSample,
  pushPanSample,
  VELOCITY_WINDOW_MS
} from './pan'

/** A steady drag: `speed` px/ms along +x, sampled every 16ms up to `endT`. */
function steadyDrag(speed: number, endT: number, count = 6): PanSample[] {
  const samples: PanSample[] = []
  for (let i = count - 1; i >= 0; i--) {
    const t = endT - i * 16
    samples.push({ x: speed * t, y: 0, t })
  }
  return samples
}

describe('pushPanSample', () => {
  test('keeps only samples inside the velocity window', () => {
    const samples: PanSample[] = []
    pushPanSample(samples, { x: 0, y: 0, t: 0 })
    pushPanSample(samples, { x: 5, y: 0, t: 80 })
    pushPanSample(samples, { x: 30, y: 0, t: VELOCITY_WINDOW_MS + 60 })
    expect(samples.length).toBe(2)
    expect(samples[0]?.t).toBe(80)
  })
})

describe('flingVelocity', () => {
  test('measures a steady drag speed', () => {
    const v = flingVelocity(steadyDrag(1, 1000), 1000)
    expect(v?.vx ?? 0).toBeCloseTo(1)
    expect(v?.vy ?? 0).toBeCloseTo(0)
  })

  test('a slow positioning drag does not fling', () => {
    expect(flingVelocity(steadyDrag(FLING_MIN_LAUNCH / 2, 1000), 1000)).toBe(null)
  })

  test('pausing before release parks instead of flinging', () => {
    // Fast drag, but the newest sample is already older than the window:
    // the pointer sat still before the button lifted.
    const v = flingVelocity(steadyDrag(2, 1000), 1000 + VELOCITY_WINDOW_MS + 50)
    expect(v).toBe(null)
  })

  test('too little history is noise, not velocity', () => {
    expect(flingVelocity([], 0)).toBe(null)
    expect(flingVelocity([{ x: 0, y: 0, t: 0 }], 0)).toBe(null)
    const jitter: PanSample[] = [
      { x: 0, y: 0, t: 0 },
      { x: 9, y: 0, t: 5 }
    ]
    expect(flingVelocity(jitter, 5)).toBe(null)
  })
})

describe('decayFling', () => {
  test('velocity decays and distance follows it', () => {
    const step = decayFling(1, -0.5, 16)
    expect(step.vx).toBeLessThan(1)
    expect(step.vx).toBeGreaterThan(0)
    expect(step.dx).toBeGreaterThan(0)
    expect(step.dy).toBeLessThan(0)
    expect(step.done).toBe(false)
  })

  test('is frame-rate independent: two 8ms steps equal one 16ms step', () => {
    const half = decayFling(1, 0, 8)
    const rest = decayFling(half.vx, 0, 8)
    const whole = decayFling(1, 0, 16)
    expect(half.dx + rest.dx).toBeCloseTo(whole.dx, 6)
    expect(rest.vx).toBeCloseTo(whole.vx, 6)
  })

  test('reports done once the glide is crawling', () => {
    let vx = 1
    let done = false
    let elapsed = 0
    while (!done && elapsed < 10000) {
      const step = decayFling(vx, 0, 16)
      vx = step.vx
      done = step.done
      elapsed += 16
    }
    expect(done).toBe(true)
    expect(vx).toBeLessThan(FLING_MIN_SPEED)
    // ~ln(v0/vmin)·τ of glide — a familiar, not endless, coast.
    expect(elapsed).toBeLessThan(2000)
  })
})
