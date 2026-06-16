// Swipe: both revisions stacked, with a draggable divider revealing old on
// the left and new on the right. The new layer is clipped at the divider in
// viewport space, so the split line stays put while the image pans and zooms
// underneath it — exactly how a film wipe behaves.

import { useCallback, useRef, useState } from 'react'
import type { AnchorMode } from '@/lib/image-diff'
import type { DecodedImage } from '@/lib/useDecodedImage'
import type { PanZoom } from '@/lib/usePanZoom'
import { ImageLayer, Viewport, World } from './stage'

interface Props {
  oldImage: DecodedImage
  newImage: DecodedImage
  frame: { width: number; height: number }
  panZoom: PanZoom
  anchor: AnchorMode
}

export function SwipeMode({ oldImage, newImage, frame, panZoom, anchor }: Props) {
  /** Divider position as a fraction of the viewport width. */
  const [split, setSplit] = useState(0.5)
  const containerRef = useRef<HTMLDivElement>(null)

  // The whole divider is the drag surface (a 14px invisible strip around the
  // 2px line — splitter-style tolerance), not just the knob.
  const onDividerDown = useCallback((e: React.PointerEvent) => {
    // Left or middle button, matching the stage's pan (middle acts as
    // primary across the image viewer); never the context-menu button.
    if (e.button !== 0 && e.button !== 1) return
    const el = containerRef.current
    if (!el) return
    const strip = e.currentTarget as HTMLElement
    strip.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      setSplit(Math.min(0.98, Math.max(0.02, (ev.clientX - rect.left) / rect.width)))
    }
    const up = () => {
      strip.removeEventListener('pointermove', move)
      strip.removeEventListener('pointerup', up)
      strip.removeEventListener('pointercancel', up)
      strip.removeEventListener('lostpointercapture', up)
    }
    strip.addEventListener('pointermove', move)
    strip.addEventListener('pointerup', up)
    strip.addEventListener('pointercancel', up)
    // Same safety net as the stage pan: end the drag whenever the capture is
    // lost, even if the release lands outside the window.
    strip.addEventListener('lostpointercapture', up)
  }, [])

  // At far-out zoom the 32px knob would cover the whole picture — fade it
  // away and let the (fully draggable) line carry the interaction.
  const { scale } = panZoom.transform
  const handleHidden = Math.min(frame.width * scale, frame.height * scale) < 96

  return (
    <div className="img-swipe" ref={containerRef}>
      <Viewport panZoom={panZoom}>
        <World panZoom={panZoom} frame={frame}>
          <ImageLayer image={oldImage} frame={frame} side="old" anchor={anchor} />
        </World>
        {/* The new revision rides the same transform inside a viewport-level
            clip, so only the divider decides how much of it shows. */}
        <div className="img-swipe__reveal" style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }}>
          <World panZoom={panZoom} frame={frame}>
            <ImageLayer image={newImage} frame={frame} side="new" anchor={anchor} />
          </World>
        </div>
        {/* data-no-pan: the viewport's native pan listener fires before any
            React handler here could stopPropagation — the stage checks the
            attribute instead (see usePanZoom NO_PAN_TARGETS). Double-click
            snaps the split back to center. */}
        <div
          className="img-swipe__divider"
          style={{ left: `${split * 100}%` }}
          data-no-pan
          onPointerDown={onDividerDown}
          onDoubleClick={() => setSplit(0.5)}
        >
          <div className={`img-swipe__handle${handleHidden ? ' img-swipe__handle--hidden' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M5 3 1.8 7 5 11M9 3l3.2 4L9 11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
        <span className="img-side-chip img-side-chip--old">Old</span>
        <span className="img-side-chip img-side-chip--new img-side-chip--right">New</span>
      </Viewport>
    </div>
  )
}
