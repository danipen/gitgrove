// The rAF driver for drag flings: collects pointer samples while a pan drag
// is live, launches a decaying glide on release, and hands every frame's
// delta to the canvas. Only this file touches time and frames — the velocity
// and decay math stays pure and tested in pan.ts.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { decayFling, flingVelocity, type PanSample, pushPanSample } from './pan'

/** Frame gaps beyond this (background tab, stall) don't teleport the view. */
const MAX_FRAME_MS = 64

export interface PanInertia {
  /** Feed the drag's pointer positions (screen px) while panning. */
  sample(x: number, y: number): void
  /** The drag ended — fling if the release was a flick, else do nothing. */
  release(): void
  /** The user (or another gesture) took over — stop dead and forget. */
  cancel(): void
}

export function usePanInertia(
  /** Pans by a delta and reports how far the view ACTUALLY moved after
   *  clamping — a pinned axis kills that axis's velocity (no edge-buzzing). */
  panBy: (dx: number, dy: number) => { dx: number; dy: number }
): PanInertia {
  const samplesRef = useRef<PanSample[]>([])
  const velocityRef = useRef<{ vx: number; vy: number } | null>(null)
  const frameRef = useRef<number | null>(null)
  const lastFrameRef = useRef(0)

  const panByRef = useRef(panBy)
  panByRef.current = panBy

  const cancel = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    velocityRef.current = null
    samplesRef.current = []
  }, [])

  const step = useCallback(() => {
    const velocity = velocityRef.current
    if (!velocity) {
      frameRef.current = null
      return
    }
    const now = performance.now()
    const dt = Math.min(MAX_FRAME_MS, now - lastFrameRef.current)
    lastFrameRef.current = now
    const next = decayFling(velocity.vx, velocity.vy, dt)
    const applied = panByRef.current(next.dx, next.dy)
    // An axis the clamp pinned has nowhere left to glide.
    const vx = Math.abs(applied.dx - next.dx) > 0.5 ? 0 : next.vx
    const vy = Math.abs(applied.dy - next.dy) > 0.5 ? 0 : next.vy
    if (next.done || (vx === 0 && vy === 0)) {
      velocityRef.current = null
      frameRef.current = null
      return
    }
    velocityRef.current = { vx, vy }
    frameRef.current = requestAnimationFrame(step)
  }, [])

  const sample = useCallback((x: number, y: number) => {
    pushPanSample(samplesRef.current, { x, y, t: performance.now() })
  }, [])

  const release = useCallback(() => {
    const velocity = flingVelocity(samplesRef.current, performance.now())
    samplesRef.current = []
    if (!velocity) return
    velocityRef.current = velocity
    lastFrameRef.current = performance.now()
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(step)
  }, [step])

  useEffect(() => cancel, [cancel])

  // Stable identity, so callers can list the handle in hook deps freely.
  return useMemo(() => ({ sample, release, cancel }), [sample, release, cancel])
}
