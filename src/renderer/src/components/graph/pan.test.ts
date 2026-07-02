import { describe, expect, test } from 'bun:test'
import {
  decayFling,
  FLING_MAX_SPEED,
  FLING_MIN_LAUNCH,
  FLING_MIN_SPEED,
  FLING_TAU_MAX_MS,
  FLING_TAU_MIN_MS,
  flingTau,
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

  test('a short fast flick still flings: grab-point seed plus one move', () => {
    // A whole flick can dispatch a single pointermove; the pointerdown seed
    // provides the second sample that makes the velocity measurable.
    const flick: PanSample[] = [
      { x: 0, y: 0, t: 0 },
      { x: 48, y: 0, t: 16 }
    ]
    const v = flingVelocity(flick, 20)
    expect(v?.vx ?? 0).toBeCloseTo(3)
    expect(v?.vy ?? 0).toBeCloseTo(0)
  })

  test('a violent flick is clamped to the speed ceiling', () => {
    const violent: PanSample[] = [
      { x: 0, y: 0, t: 0 },
      { x: 90, y: 120, t: 12 }
    ]
    const v = flingVelocity(violent, 12)
    expect(v).not.toBe(null)
    if (!v) return
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(FLING_MAX_SPEED)
    // The clamp preserves direction: 90:120 is 3:4.
    expect(v.vy / v.vx).toBeCloseTo(120 / 90)
    // A clamped launch also earns the longest coast.
    expect(v.tauMs).toBe(flingTau(FLING_MAX_SPEED))
  })

  test('a harder throw coasts disproportionately farther', () => {
    // A fling's total glide is exactly v₀·τ(v₀); τ growing with speed makes
    // the distance superlinear — the touch-screen feel.
    const glide = (v0: number) => v0 * flingTau(v0)
    expect(glide(4)).toBeGreaterThan(4 * glide(1))
    // …but never unbounded: τ is capped.
    expect(flingTau(100)).toBe(FLING_TAU_MAX_MS)
    expect(flingTau(0)).toBe(FLING_TAU_MIN_MS)
  })

  test('a small quick drag still flings', () => {
    // 12px in 24ms — tiny travel, but a decisive gesture.
    const small: PanSample[] = [
      { x: 0, y: 0, t: 0 },
      { x: 8, y: 0, t: 16 },
      { x: 12, y: 0, t: 24 }
    ]
    const v = flingVelocity(small, 28)
    expect(v?.vx ?? 0).toBeCloseTo(0.5)
  })

  test('too little history is noise, not velocity', () => {
    expect(flingVelocity([], 0)).toBe(null)
    expect(flingVelocity([{ x: 0, y: 0, t: 0 }], 0)).toBe(null)
    const jitter: PanSample[] = [
      { x: 0, y: 0, t: 0 },
      { x: 9, y: 0, t: 3 }
    ]
    expect(flingVelocity(jitter, 3)).toBe(null)
  })
})

describe('decayFling', () => {
  test('velocity decays and distance follows it', () => {
    const step = decayFling(1, -0.5, 16, FLING_TAU_MIN_MS)
    expect(step.vx).toBeLessThan(1)
    expect(step.vx).toBeGreaterThan(0)
    expect(step.dx).toBeGreaterThan(0)
    expect(step.dy).toBeLessThan(0)
    expect(step.done).toBe(false)
  })

  test('is frame-rate independent: two 8ms steps equal one 16ms step', () => {
    const half = decayFling(1, 0, 8, FLING_TAU_MIN_MS)
    const rest = decayFling(half.vx, 0, 8, FLING_TAU_MIN_MS)
    const whole = decayFling(1, 0, 16, FLING_TAU_MIN_MS)
    expect(half.dx + rest.dx).toBeCloseTo(whole.dx, 6)
    expect(rest.vx).toBeCloseTo(whole.vx, 6)
  })

  test('reports done once the glide is crawling', () => {
    const settleMs = (v0: number) => {
      const tau = flingTau(v0)
      let vx = v0
      let done = false
      let elapsed = 0
      while (!done && elapsed < 20000) {
        const step = decayFling(vx, 0, 16, tau)
        vx = step.vx
        done = step.done
        elapsed += 16
      }
      expect(done).toBe(true)
      expect(vx).toBeLessThan(FLING_MIN_SPEED)
      return elapsed
    }
    // ~ln(v0/vmin)·τ of glide — a familiar, not endless, coast.
    expect(settleMs(1)).toBeLessThan(2000)
    // Even the hardest clamped throw settles within a few seconds.
    expect(settleMs(FLING_MAX_SPEED)).toBeLessThan(6000)
  })
})
