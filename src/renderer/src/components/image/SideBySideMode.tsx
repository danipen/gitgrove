// Side by side: old and new in two synchronized panes. Both halves bind the
// same PanZoom, so zooming or panning either one moves both — comparing the
// same region never needs manual re-alignment.

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

export function SideBySideMode({ oldImage, newImage, frame, panZoom, anchor }: Props) {
  return (
    <div className="img-sbs">
      <Viewport panZoom={panZoom} className="img-sbs__pane">
        <World panZoom={panZoom} frame={frame}>
          <ImageLayer image={oldImage} frame={frame} side="old" anchor={anchor} />
        </World>
        <span className="img-side-chip img-side-chip--old">Old</span>
      </Viewport>
      <Viewport panZoom={panZoom} className="img-sbs__pane">
        <World panZoom={panZoom} frame={frame}>
          <ImageLayer image={newImage} frame={frame} side="new" anchor={anchor} />
        </World>
        {/* Outer corner: the inner one sits under the floating mode switcher. */}
        <span className="img-side-chip img-side-chip--new img-side-chip--right">New</span>
      </Viewport>
    </div>
  )
}
