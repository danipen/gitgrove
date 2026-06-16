// Onion skin: the new revision is layered over the old one and a slider
// blends between them — the classic way to spot what moved. Play automates
// the slider: the blend snaps between all-old and all-new at 2 Hz (the
// comparator's blink — the eye is a superb motion detector, so anything that
// moved pops). The cut is hard, never a fade: easing would smear exactly the
// pop the eye keys on. The thumb visibly jumps with each cut, so the feature
// explains itself; touching the slider pauses playback.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/lib/icons'
import type { AnchorMode } from '@/lib/image-diff'
import type { DecodedImage } from '@/lib/useDecodedImage'
import type { PanZoom } from '@/lib/usePanZoom'
import { ImageLayer, Viewport, World } from './stage'

/** Half a blink period: each revision holds the screen this long. */
const BLINK_INTERVAL_MS = 500

interface Props {
  oldImage: DecodedImage
  newImage: DecodedImage
  frame: { width: number; height: number }
  panZoom: PanZoom
  anchor: AnchorMode
  /** 0 = all old, 1 = all new. Owned by the viewer so it survives mode trips. */
  blend: number
  onBlendChange: (blend: number) => void
}

export function OnionSkinMode({
  oldImage,
  newImage,
  frame,
  panZoom,
  anchor,
  blend,
  onBlendChange
}: Props) {
  const [playing, setPlaying] = useState(false)
  // The interval toggles from the latest blend without retriggering the
  // effect on every cut (the effect must only restart on play/pause).
  const blendRef = useRef(blend)
  blendRef.current = blend

  useEffect(() => {
    if (!playing) return
    const snap = () => onBlendChange(blendRef.current >= 0.5 ? 0 : 1)
    // Snap immediately so pressing play responds on the spot, not 500ms later.
    snap()
    const id = setInterval(snap, BLINK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [playing, onBlendChange])

  return (
    <Viewport panZoom={panZoom}>
      <World panZoom={panZoom} frame={frame}>
        <ImageLayer image={oldImage} frame={frame} side="old" anchor={anchor} />
        <ImageLayer image={newImage} frame={frame} side="new" anchor={anchor} opacity={blend} />
      </World>
      <div className="img-pill img-onion-slider">
        <button
          className="icon-btn"
          data-tip={playing ? 'Pause' : 'Blink between old and new'}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? <Icon.Pause size={16} /> : <Icon.Play size={16} />}
        </button>
        <span className="img-pill__label">Old</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={blend}
          aria-label="Blend between old and new revision"
          onChange={(e) => {
            // A manual blend is the user taking the wheel: stop blinking.
            setPlaying(false)
            onBlendChange(Number(e.target.value))
          }}
        />
        <span className="img-pill__label">New</span>
      </div>
    </Viewport>
  )
}
