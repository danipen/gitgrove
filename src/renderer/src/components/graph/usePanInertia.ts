// The rAF driver for drag flings: collects pointer samples while a pan drag
// is live, launches a decaying glide on release, and hands every frame's
// delta to the canvas. Only this file touches time and frames — the velocity
// and decay math stays pure and tested in pan.ts.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { decayFling, type Fling, flingVelocity, type PanSample, pushPanSample } from './pan'

/** Frame gaps beyond this (background tab, stall) don't teleport the view. */
const MAX_FRAME_MS = 64

export interface PanInertia {
  /** Feed the drag's pointer positions (screen px). Pass the event's own
   *  timeStamp when available: coalesced pointer events all *dispatch* in one
   *  frame, but carry the hardware timestamps the velocity math needs. */
  sample(x: number, y: number, t?: number): void
  /** The drag ended — fling if the release was a flick, else do nothing. */
  release(): void
  /** The drag's event stream was cut before the release could be observed
   *  (Chromium drops non-primary-button capture at the window edge, so an
   *  off-window release only surfaces when the cursor re-enters). Fling with
   *  the velocity the drag carried when the stream went silent — a flick
   *  that sails out of the window must coast, same as on a touch screen. */
  releaseDetached(): void
  /** The user (or another gesture) took over — stop dead and forget. */
  cancel(): void
}

export function usePanInertia(
  /** Pans by a delta and reports how far the view ACTUALLY moved after
   *  clamping — a pinned axis kills that axis's velocity (no edge-buzzing). */
  panBy: (dx: number, dy: number) => { dx: number; dy: number }
): PanInertia {
  const samplesRef = useRef<PanSample[]>([])
  const flingRef = useRef<Fling | null>(null)
  const frameRef = useRef<number | null>(null)
  const lastFrameRef = useRef(0)

  const panByRef = useRef(panBy)
  panByRef.current = panBy

  const cancel = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    flingRef.current = null
    samplesRef.current = []
  }, [])

  const step = useCallback(() => {
    const fling = flingRef.current
    if (!fling) {
      frameRef.current = null
      return
    }
    const now = performance.now()
    const dt = Math.min(MAX_FRAME_MS, now - lastFrameRef.current)
    lastFrameRef.current = now
    const next = decayFling(fling.vx, fling.vy, dt, fling.tauMs)
    const applied = panByRef.current(next.dx, next.dy)
    // An axis the clamp pinned has nowhere left to glide.
    const vx = Math.abs(applied.dx - next.dx) > 0.5 ? 0 : next.vx
    const vy = Math.abs(applied.dy - next.dy) > 0.5 ? 0 : next.vy
    if (next.done || (vx === 0 && vy === 0)) {
      flingRef.current = null
      frameRef.current = null
      return
    }
    flingRef.current = { vx, vy, tauMs: fling.tauMs }
    frameRef.current = requestAnimationFrame(step)
  }, [])

  const sample = useCallback((x: number, y: number, t = performance.now()) => {
    // Event timeStamps and performance.now() share a timebase in Chromium,
    // so hardware-stamped samples and the release clock compare directly.
    pushPanSample(samplesRef.current, { x, y, t })
  }, [])

  const launch = useCallback(
    (fling: Fling | null) => {
      samplesRef.current = []
      if (!fling) return
      flingRef.current = fling
      lastFrameRef.current = performance.now()
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(step)
    },
    [step]
  )

  const release = useCallback(() => {
    // Measured against the wall clock: pausing before lifting parks the view.
    launch(flingVelocity(samplesRef.current, performance.now()))
  }, [launch])

  const releaseDetached = useCallback(() => {
    // The wall clock lies here — the release event arrived late because the
    // stream was cut, not because the pointer parked. Measure at the moment
    // of the last sample we actually saw.
    const samples = samplesRef.current
    const last = samples[samples.length - 1]
    launch(last ? flingVelocity(samples, last.t) : null)
  }, [launch])

  useEffect(() => cancel, [cancel])

  // Stable identity, so callers can list the handle in hook deps freely.
  return useMemo(
    () => ({ sample, release, releaseDetached, cancel }),
    [sample, release, releaseDetached, cancel]
  )
}
