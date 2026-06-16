// The image pane: a single preview for added/deleted images, and a four-mode
// visual diff (onion skin — with its blink autoplay — / side by side /
// differences / swipe) for modified ones. The mode control lives in the diff
// header (DiffViewer renders it in the same spot text diffs show
// Split/Unified — one place for "how do I view this diff" across the app).
// One shared pan/zoom drives every mode, so switching modes keeps the
// framing; zoom controls float over the stage (joined by the anchor toggle
// when the revisions differ in size); an HUD strip narrates the change
// (dimensions, sizes, % of pixels that differ) and a pixel inspector reports
// exact texels from 8× zoom.

import type { ImageDiffSides } from '@shared/types'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { type AnchorMode, composedSize, MAX_TOLERANCE, zoomLabel } from '@/lib/image-diff'
import { usePersistentState } from '@/lib/persist'
import { type DecodedImage, useDecodedImage } from '@/lib/useDecodedImage'
import { usePanZoom } from '@/lib/usePanZoom'
import { type DiffComposition, DifferencesMode, type DiffStats } from './DifferencesMode'
import { OnionSkinMode } from './OnionSkinMode'
import { PixelInspector } from './PixelInspector'
import { SideBySideMode } from './SideBySideMode'
import { SwipeMode } from './SwipeMode'
import { ImageLayer, Viewport, World } from './stage'

export type ImageDiffMode = 'onion' | 'side-by-side' | 'differences' | 'swipe'

interface ImageModeDef {
  id: ImageDiffMode
  label: string
  /** Tooltip text when the label is an abbreviation; defaults to the label. */
  title?: string
  icon: (size: number) => ReactNode
}

/** The header's mode options, in the order they read naturally. Labels are
 *  deliberately one short word each — four segments share the header with
 *  the file path. Tooltips carry the full names. (Blink lives inside Onion
 *  as its play button — it's the blend automated, not a fifth way to look.) */
export const IMAGE_DIFF_MODES: ImageModeDef[] = [
  { id: 'onion', label: 'Onion', title: 'Onion skin', icon: (s) => <Icon.Onion size={s} /> },
  { id: 'side-by-side', label: 'Split', icon: (s) => <Icon.Split size={s} /> },
  {
    id: 'differences',
    label: 'Diffs',
    title: 'Differences',
    icon: (s) => <Icon.Compare size={s} />
  },
  { id: 'swipe', label: 'Swipe', icon: (s) => <Icon.Swipe size={s} /> }
]

interface Props {
  image: ImageDiffSides
  /** Active diff mode; owned by DiffViewer (the header's segmented control). */
  mode: ImageDiffMode
}

/** "1024×768 · 245 KB" — one revision's identity card for the HUD. */
function sideLabel(image: DecodedImage, bytes: number): string {
  return `${image.width}×${image.height} · ${formatBytes(bytes)}`
}

export function ImageDiffViewer({ image, mode }: Props) {
  const oldState = useDecodedImage(image.old?.dataUrl)
  const newState = useDecodedImage(image.new?.dataUrl)
  // Onion blend lives here (not in the mode) so a trip through other modes
  // comes back to the same mix. Reset per file via the image-keyed effect.
  const [blend, setBlend] = useState(0.5)
  const [stats, setStats] = useState<DiffStats | null>(null)
  const diffCache = useRef<DiffComposition | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  // Anchor and tolerance are workflow preferences (a QA pass sets them once),
  // so they persist — validated, since a stale/garbage key must not wedge the
  // stage into an impossible state.
  const [anchorPref, setAnchorPref] = usePersistentState<AnchorMode>('gg.imageDiffAnchor', 'center')
  const anchor: AnchorMode = anchorPref === 'top-left' ? 'top-left' : 'center'
  const [tolerancePref, setTolerancePref] = usePersistentState<number>('gg.imageDiffTolerance', 0)
  const threshold = Number.isFinite(tolerancePref)
    ? Math.min(MAX_TOLERANCE, Math.max(0, Math.round(tolerancePref)))
    : 0

  const oldImage = oldState.status === 'ready' ? oldState.image : null
  const newImage = newState.status === 'ready' ? newState.image : null
  const isDiff = image.old !== null && image.new !== null
  const sizesDiffer =
    !!oldImage &&
    !!newImage &&
    (oldImage.width !== newImage.width || oldImage.height !== newImage.height)

  // The composed frame both revisions are laid out in (max of both sizes).
  const frame = useMemo(() => {
    if (oldImage && newImage) return composedSize(oldImage, newImage)
    const single = newImage ?? oldImage
    return single ? { width: single.width, height: single.height } : null
  }, [oldImage, newImage])

  const panZoom = usePanZoom(frame)

  // New file selected: stats and blend belong to the previous pair.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the image payload identity by design.
  useEffect(() => {
    setStats(null)
    setBlend(0.5)
  }, [image])

  const onStats = useCallback((s: DiffStats) => setStats(s), [])

  // Keyboard zoom on the focused stage: +/− step, 0 fits, 1 is 100%.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') panZoom.zoomIn()
      else if (e.key === '-') panZoom.zoomOut()
      else if (e.key === '0') panZoom.zoomToFit()
      else if (e.key === '1') panZoom.zoomToActualSize()
      else return
      e.preventDefault()
    },
    [panZoom]
  )

  if (oldState.status === 'error' || newState.status === 'error') {
    return (
      <div className="center-state">
        <div className="icon-ring">
          <Icon.Image size={22} />
        </div>
        <h3>Couldn't display this image</h3>
        <p>The file looks like an image but couldn't be decoded.</p>
      </div>
    )
  }
  if (!frame || (isDiff && (!oldImage || !newImage))) {
    return (
      <div className="center-state">
        <div className="spinner" />
      </div>
    )
  }

  const changedPercent =
    stats && stats.coveredPixels > 0 ? (stats.changedPixels / stats.coveredPixels) * 100 : null

  return (
    <div className="img-pane" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="img-stage-area" ref={stageRef}>
        {!isDiff && (oldImage || newImage) && (
          <Viewport panZoom={panZoom}>
            <World panZoom={panZoom} frame={frame}>
              {oldImage && <ImageLayer image={oldImage} frame={frame} side="old" />}
              {newImage && <ImageLayer image={newImage} frame={frame} side="new" />}
            </World>
          </Viewport>
        )}
        {isDiff && oldImage && newImage && (
          <>
            {mode === 'onion' && (
              <OnionSkinMode
                oldImage={oldImage}
                newImage={newImage}
                frame={frame}
                panZoom={panZoom}
                anchor={anchor}
                blend={blend}
                onBlendChange={setBlend}
              />
            )}
            {mode === 'side-by-side' && (
              <SideBySideMode
                oldImage={oldImage}
                newImage={newImage}
                frame={frame}
                panZoom={panZoom}
                anchor={anchor}
              />
            )}
            {mode === 'differences' && (
              <DifferencesMode
                oldImage={oldImage}
                newImage={newImage}
                frame={frame}
                panZoom={panZoom}
                anchor={anchor}
                threshold={threshold}
                onThresholdChange={setTolerancePref}
                cache={diffCache}
                onStats={onStats}
              />
            )}
            {mode === 'swipe' && (
              <SwipeMode
                oldImage={oldImage}
                newImage={newImage}
                frame={frame}
                panZoom={panZoom}
                anchor={anchor}
              />
            )}
          </>
        )}

        <div className="img-zoom">
          <button
            className="img-zoom__pct"
            data-tip="Zoom to fit"
            onClick={() => panZoom.zoomToFit()}
          >
            {zoomLabel(panZoom.transform.scale)}
          </button>
          <button className="icon-btn" data-tip="Zoom in" onClick={() => panZoom.zoomIn()}>
            <Icon.ZoomIn size={15} />
          </button>
          <button className="icon-btn" data-tip="Zoom out" onClick={() => panZoom.zoomOut()}>
            <Icon.ZoomOut size={15} />
          </button>
          <button
            className={`icon-btn${panZoom.fitted ? ' is-active' : ''}`}
            data-tip="Zoom to fit"
            onClick={() => panZoom.zoomToFit()}
          >
            <Icon.Fit size={15} />
          </button>
          <button
            className="icon-btn"
            data-tip="Actual size"
            onClick={() => panZoom.zoomToActualSize()}
          >
            <Icon.ActualSize size={15} />
          </button>
          {/* Resized image: how should the two sizes align? Centered (the
              UVCS convention) or by their top-left corners (how canvases
              usually grow). Hidden when sizes match — it would do nothing. */}
          {isDiff && sizesDiffer && (
            <>
              <div className="img-zoom__sep" />
              <button
                className={`icon-btn${anchor === 'center' ? ' is-active' : ''}`}
                data-tip="Align centers"
                onClick={() => setAnchorPref('center')}
              >
                <Icon.AnchorCenter size={15} />
              </button>
              <button
                className={`icon-btn${anchor === 'top-left' ? ' is-active' : ''}`}
                data-tip="Align top-left corners"
                onClick={() => setAnchorPref('top-left')}
              >
                <Icon.AnchorCorner size={15} />
              </button>
            </>
          )}
        </div>

        <PixelInspector
          oldImage={oldImage}
          newImage={newImage}
          frame={frame}
          anchor={anchor}
          panZoom={panZoom}
          stageRef={stageRef}
        />

        <div className="img-hud">
          {oldImage && image.old && (
            <span className="img-hud__side img-hud__side--old">
              {sideLabel(oldImage, image.old.bytes)}
            </span>
          )}
          {oldImage && newImage && <span className="img-hud__arrow">→</span>}
          {newImage && image.new && (
            <span className="img-hud__side img-hud__side--new">
              {sideLabel(newImage, image.new.bytes)}
            </span>
          )}
          {mode === 'differences' && isDiff && changedPercent !== null && (
            <span className="img-hud__stat">{changedLabel(changedPercent, threshold)}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** The % readout must stay honest: with a tolerance applied, zero changes
 *  means "nothing above the tolerance", not "pixel-identical". */
function changedLabel(changedPercent: number, threshold: number): string {
  if (changedPercent === 0) return threshold > 0 ? 'no changes above tolerance' : 'pixel-identical'
  return `${changedPercent < 0.1 ? '< 0.1' : changedPercent.toFixed(1)}% of pixels differ`
}
