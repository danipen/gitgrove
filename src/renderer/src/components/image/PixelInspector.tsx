// Pixel inspector: from 8× zoom, hovering reports the exact texel under the
// cursor — frame coordinates plus the old → new color, swatches included.
// Pixel forensics without an eyedropper round trip to an external editor.
// State lives here so the per-pixel pointermove never re-renders the viewer;
// the listener attaches to the stage element the viewer hands down.

import { type RefObject, useEffect, useRef, useState } from 'react'
import { type AnchorMode, anchoredOffset, type ViewTransform } from '@/lib/image-diff'
import { rasterize } from '@/lib/rasterize'
import type { DecodedImage } from '@/lib/useDecodedImage'
import type { PanZoom } from '@/lib/usePanZoom'

/** The inspector arms past this zoom — texels are ≥ 8 screen pixels, so the
 *  cursor can actually address one. */
const MIN_INSPECT_ZOOM = 8

/** Controls layered over the stage: hovering them inspects nothing. */
const CONTROL_TARGETS = 'button, input, [data-no-pan]'

type Rgba = [number, number, number, number]

interface Sample {
  /** Composed-frame coordinates (matches what both revisions are laid out in). */
  x: number
  y: number
  /** null = that side doesn't cover this pixel (differently-sized revisions). */
  old: Rgba | null
  new: Rgba | null
}

interface Props {
  oldImage: DecodedImage | null
  newImage: DecodedImage | null
  frame: { width: number; height: number }
  anchor: AnchorMode
  panZoom: PanZoom
  /** The stage element to listen on (the viewer's .img-stage-area). */
  stageRef: RefObject<HTMLDivElement | null>
}

function samplePixel(
  image: DecodedImage | null,
  frame: { width: number; height: number },
  anchor: AnchorMode,
  fx: number,
  fy: number
): Rgba | null {
  if (!image) return null
  const off = anchoredOffset(frame, image, anchor)
  const x = fx - off.x
  const y = fy - off.y
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return null
  // Cached after the first call — the initial rasterize of a huge image is
  // the one main-thread hit, and the differences mode usually paid it already.
  const bitmap = rasterize(image)
  const i = (y * bitmap.width + x) * 4
  return [bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2], bitmap.data[i + 3]]
}

export function PixelInspector({ oldImage, newImage, frame, anchor, panZoom, stageRef }: Props) {
  const [sample, setSample] = useState<Sample | null>(null)
  // The pointermove handler reads the live transform through a ref so the
  // listener binds once, not on every pan frame.
  const transformRef = useRef<ViewTransform>(panZoom.transform)
  transformRef.current = panZoom.transform

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const clear = () => setSample(null)
    const onMove = (e: PointerEvent) => {
      const t = transformRef.current
      const target = e.target as HTMLElement
      const viewport = target.closest('.img-viewport')
      if (t.scale < MIN_INSPECT_ZOOM || !viewport || target.closest(CONTROL_TARGETS)) {
        clear()
        return
      }
      const rect = viewport.getBoundingClientRect()
      const fx = Math.floor((e.clientX - rect.left - t.x) / t.scale)
      const fy = Math.floor((e.clientY - rect.top - t.y) / t.scale)
      if (fx < 0 || fx >= frame.width || fy < 0 || fy >= frame.height) {
        clear()
        return
      }
      setSample({
        x: fx,
        y: fy,
        old: samplePixel(oldImage, frame, anchor, fx, fy),
        new: samplePixel(newImage, frame, anchor, fx, fy)
      })
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', clear)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', clear)
      setSample(null)
    }
  }, [stageRef, frame, anchor, oldImage, newImage])

  if (!sample) return null
  const isDiff = oldImage !== null && newImage !== null
  return (
    <div className="img-inspector">
      <span className="img-inspector__pos">
        {sample.x},{sample.y}
      </span>
      {isDiff ? (
        <>
          <Swatch rgba={sample.old} />
          <span className="img-inspector__arrow">→</span>
          <Swatch rgba={sample.new} />
        </>
      ) : (
        <Swatch rgba={sample.new ?? sample.old} />
      )}
    </div>
  )
}

/** #RRGGBB, with /AA appended only when the pixel isn't fully opaque. */
function hexOf([r, g, b, a]: Rgba): string {
  const h = (v: number) => v.toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}${a !== 255 ? `/${h(a)}` : ''}`
}

const SWATCH_CHECKER = 'repeating-conic-gradient(var(--img-checker) 0% 25%, transparent 0% 50%)'

function Swatch({ rgba }: { rgba: Rgba | null }) {
  if (!rgba) return <span className="img-inspector__none">—</span>
  const color = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3] / 255})`
  return (
    <span className="img-inspector__color">
      <span
        className="img-inspector__swatch"
        // The color rides as a gradient layer over the checkerboard — a plain
        // background-color would paint *under* it.
        style={{ backgroundImage: `linear-gradient(${color}, ${color}), ${SWATCH_CHECKER}` }}
      />
      {hexOf(rgba)}
    </span>
  )
}
