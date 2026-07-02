// Smooth wheel zooming for the Graph canvas: pure momentum math, no DOM.
//
// A trackpad pinch streams dozens of tiny fractional deltas per second, so
// applying each one directly already looks smooth — that path stays 1:1 and
// never comes here. A mouse wheel is the opposite: one big discrete delta per
// notch, which lands as a hard step. This module turns those notches into an
// animated glide (a technique borrowed from Plastic SCM's Branch Explorer):
//
// - Each notch multiplies an accumulated TARGET scale (not the live scale),
//   so spinning the wheel while an animation runs compounds the target and
//   the view keeps gliding toward it instead of restarting from scratch.
// - Spinning during flight also EXTENDS the animation window (capped), which
//   reads as momentum: the faster you spin, the longer the glide.
// - Reversing direction mid-flight snaps the target back to the current
//   scale first, so one contrary notch doesn't have to fight the leftover
//   momentum of the previous gesture.
//
// The rAF driver lives in useZoomAnimation.ts; this file stays pure so the
// accumulate/classify/curve logic is unit-testable without a canvas.

import { MAX_SCALE, MIN_SCALE } from './geometry'

/** Scale factor applied per plain wheel notch (1/0.9 ≈ 11% per click). */
const NOTCH_SENSITIVITY = 0.1
/** Sensitivity ceiling for accelerated wheels that report multi-notch deltas. */
const MAX_SENSITIVITY = 0.5
/** One isolated notch glides for this long… */
export const ZOOM_ANIM_MS = 200
/** …and continued spinning may stretch the glide up to this. */
export const ZOOM_ANIM_MAX_MS = 300

/** Ease-out cubic: fast start, gentle landing — the zoom "settles". */
export const cubicEaseOut = (t: number): number => 1 - (1 - t) ** 3

/**
 * Discrete wheel notch vs. continuous trackpad stream. Chromium reports both
 * pinch-zoom and two-finger scroll as pixel-mode deltas well under a notch
 * (usually < 10, always fractional-ish), while a physical wheel click is
 * ~100px — or line/page mode, which only real wheels use.
 */
export function isDiscreteWheel(deltaY: number, deltaMode: number): boolean {
  return deltaMode !== 0 || Math.abs(deltaY) >= 40
}

/**
 * Scale factor for one wheel event. deltaY < 0 (spin up) zooms in. Accelerated
 * wheels batch several notches into one event; those get a proportionally
 * stronger (but capped) factor so fast spinning still covers ground.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  // Pixel mode: ~100 per notch. Line mode: 3 lines per notch.
  const notches = Math.abs(deltaMode === 1 ? deltaY / 3 : deltaY / 100)
  const sensitivity = Math.min(MAX_SENSITIVITY, NOTCH_SENSITIVITY * Math.max(1, notches))
  return deltaY < 0 ? 1 / (1 - sensitivity) : 1 - sensitivity
}

/** One in-flight zoom gesture: where it's heading and how long the glide is. */
export interface ZoomMomentum {
  /** Accumulated destination scale (clamped to MIN/MAX_SCALE). */
  target: number
  direction: 1 | -1
  /** performance.now() of the latest notch — each notch restarts the clock. */
  startedAt: number
  /** Glide length from startedAt; grows with continued spinning. */
  duration: number
}

/**
 * Folds one zoom step (a wheel notch, a toolbar click, a +/- key) into the
 * running momentum. Same direction while still gliding: compound the target
 * and add the unspent glide time back on (capped — that's the momentum feel).
 * Opposite direction or idle: start fresh from the current scale.
 */
export function accumulateZoom(
  prev: ZoomMomentum | null,
  currentScale: number,
  factor: number,
  now: number
): ZoomMomentum {
  const direction = factor > 1 ? 1 : -1
  const carried = prev !== null && prev.direction === direction ? prev : null
  const base = carried ? carried.target : currentScale
  const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, base * factor))
  const remaining = carried ? carried.startedAt + carried.duration - now : 0
  const duration =
    carried && remaining > 0
      ? Math.min(ZOOM_ANIM_MAX_MS, carried.duration + remaining)
      : ZOOM_ANIM_MS
  return { target, direction, startedAt: now, duration }
}
