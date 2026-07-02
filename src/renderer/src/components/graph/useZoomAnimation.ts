// The rAF driver for smooth zooming: turns discrete zoom steps (mouse-wheel
// notches, toolbar clicks, +/- keys) into an eased glide toward the target
// scale computed by zoom.ts. Only this file touches time and frames — all the
// momentum math stays pure and tested over there.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { accumulateZoom, cubicEaseOut, type ZoomMomentum } from './zoom'

export interface ZoomAnimation {
  /** Fold one zoom step in and glide toward the (re)accumulated target. */
  zoomStep(anchorX: number, anchorY: number, factor: number): void
  /** Cancel the glide, freezing the view at its current scale. Any direct
   *  view manipulation (pan, pinch, fit, centering) must call this first. */
  stop(): void
}

export function useZoomAnimation(
  /** Applies an absolute scale keeping the anchor screen point fixed. */
  applyScaleAt: (anchorX: number, anchorY: number, scale: number) => void,
  getScale: () => number
): ZoomAnimation {
  const momentumRef = useRef<ZoomMomentum | null>(null)
  const frameRef = useRef<number | null>(null)
  // The running glide: scale interpolates from → momentum.target around a
  // fixed anchor. Each new step re-anchors under the pointer's latest spot.
  const glideRef = useRef<{ anchorX: number; anchorY: number; from: number } | null>(null)

  const applyRef = useRef(applyScaleAt)
  applyRef.current = applyScaleAt
  const getScaleRef = useRef(getScale)
  getScaleRef.current = getScale

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    momentumRef.current = null
    glideRef.current = null
  }, [])

  const step = useCallback(() => {
    const momentum = momentumRef.current
    const glide = glideRef.current
    if (!momentum || !glide) {
      frameRef.current = null
      return
    }
    const t = Math.min(1, (performance.now() - momentum.startedAt) / momentum.duration)
    const scale = glide.from + (momentum.target - glide.from) * cubicEaseOut(t)
    applyRef.current(glide.anchorX, glide.anchorY, scale)
    if (t >= 1) {
      // Landed. Keep the momentum record: a quick next notch in the same
      // direction should compound from this target, not re-read the scale.
      glideRef.current = null
      frameRef.current = null
      return
    }
    frameRef.current = requestAnimationFrame(step)
  }, [])

  const zoomStep = useCallback(
    (anchorX: number, anchorY: number, factor: number) => {
      const from = getScaleRef.current()
      momentumRef.current = accumulateZoom(momentumRef.current, from, factor, performance.now())
      glideRef.current = { anchorX, anchorY, from }
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(step)
    },
    [step]
  )

  useEffect(() => stop, [stop])

  // Stable identity, so callers can list the handle in hook deps freely.
  return useMemo(() => ({ zoomStep, stop }), [zoomStep, stop])
}
