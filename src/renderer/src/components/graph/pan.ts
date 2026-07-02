// Pan inertia for the Graph canvas: pure fling math, no DOM.
//
// Trackpad two-finger panning arrives as wheel events with the OS's own
// inertia already applied, so it coasts naturally. A mouse drag has no such
// help — the view stops dead the instant the button lifts. This module gives
// the drag a fling: estimate the release velocity from the drag's last few
// pointer samples, then decay it exponentially frame by frame.
//
// The rAF driver lives in usePanInertia.ts; this file stays pure so the
// velocity/decay math is unit-testable without a canvas.

/** One pointer position during a drag, in screen px / ms. */
export interface PanSample {
  x: number
  y: number
  t: number
}

/** Only movement this recent counts toward the release velocity — pausing
 *  mid-drag before letting go means "park it here", not "fling it". */
export const VELOCITY_WINDOW_MS = 100
/** px/ms below which a release is a positioning drag, not a flick. */
export const FLING_MIN_LAUNCH = 0.15
/** px/ms ceiling. A violent flick measured over a handful of ms can read
 *  absurdly fast; the clamp keeps the glide vigorous, never a teleport. */
export const FLING_MAX_SPEED = 4
/** px/ms below which the glide has landed and the frame loop stops. */
export const FLING_MIN_SPEED = 0.01
/** Exponential decay time constant — the fling loses ~63% speed per τ. */
export const FLING_TAU_MS = 250

/** Appends a sample and prunes everything older than the velocity window. */
export function pushPanSample(samples: PanSample[], sample: PanSample): void {
  samples.push(sample)
  while (samples.length > 0 && sample.t - samples[0].t > VELOCITY_WINDOW_MS) samples.shift()
}

/**
 * Release velocity (px/ms) from the drag's recent samples, or null when the
 * release shouldn't fling: too little recent movement history (the pointer
 * was parked) or a launch speed under the flick threshold.
 */
export function flingVelocity(
  samples: readonly PanSample[],
  releaseT: number
): { vx: number; vy: number } | null {
  const recent = samples.filter((s) => releaseT - s.t <= VELOCITY_WINDOW_MS)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || first === last) return null
  const dt = last.t - first.t
  // Samples are seeded from the grab point and carry hardware timestamps, so
  // this span covers the whole recent gesture: anything under a few ms is not
  // a human drag, just jitter. Small-but-quick flicks stay flingable.
  if (dt < 4) return null
  const vx = (last.x - first.x) / dt
  const vy = (last.y - first.y) / dt
  const speed = Math.hypot(vx, vy)
  if (speed < FLING_MIN_LAUNCH) return null
  const clamp = Math.min(1, FLING_MAX_SPEED / speed)
  return { vx: vx * clamp, vy: vy * clamp }
}

/**
 * Advances the fling by one frame of dtMs. The travelled distance is the
 * exact integral of the decaying velocity over the frame, so the glide's
 * total path is identical at any frame rate — 60Hz, 120Hz or a hiccup.
 */
export function decayFling(
  vx: number,
  vy: number,
  dtMs: number
): { dx: number; dy: number; vx: number; vy: number; done: boolean } {
  const decay = Math.exp(-dtMs / FLING_TAU_MS)
  const travel = FLING_TAU_MS * (1 - decay)
  const nextVx = vx * decay
  const nextVy = vy * decay
  return {
    dx: vx * travel,
    dy: vy * travel,
    vx: nextVx,
    vy: nextVy,
    done: Math.hypot(nextVx, nextVy) < FLING_MIN_SPEED
  }
}
