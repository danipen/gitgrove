import { parseDiffFromFile } from '@pierre/diffs'
import type { BaseDiffOptions, DiffLineAnnotation } from '@pierre/diffs/react'
import { FileDiff, MultiFileDiff, PatchDiff } from '@pierre/diffs/react'
import type { DiffPayload } from '@shared/types'
import { memo, useEffect, useMemo, useState } from 'react'
import {
  IMAGE_DIFF_MODES,
  type ImageDiffMode,
  ImageDiffViewer
} from '@/components/image/ImageDiffViewer'
import type { FileSelection } from '@/lib/commit-selection'
import { formatBytes, splitPath, statusLabel, statusLetter } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { usePersistentState } from '@/lib/persist'
import { buildBlockPatch, buildExcludedDiffCss, listChangeBlocks } from '@/lib/staging'
import type { ResolvedTheme } from '@/lib/theme'
import { useSpinDelay } from '@/lib/useSpinDelay'
import { ConfirmDialog } from './Dialog'

export type DiffMode = 'split' | 'unified'

/** Wiring for the change-block selection bars on working diffs. */
export interface SelectionActions {
  /** Current selection for the displayed file. */
  selection: FileSelection
  /**
   * Replace the file's block selection: selected block index → its standalone
   * patch (used at commit time), plus the total block count so the caller can
   * normalize full/empty selections back to 'all'/'none'.
   */
  onChange: (selected: Map<number, string>, totalBlocks: number) => void
  /** Discard a change block in the working tree (reverse-applies its patch). */
  onDiscard: (patch: string) => void
  busy: boolean
}

interface Props {
  diff: DiffPayload | null
  loading: boolean
  mode: DiffMode
  wrap: boolean
  theme: ResolvedTheme
  onModeChange: (mode: DiffMode) => void
  onWrapChange: (wrap: boolean) => void
  /**
   * Present for working diffs in the Changes tab: each contiguous change
   * block gets a checkbox bar ("include in commit") plus a guarded discard,
   * rendered inside the same continuous, context-expandable diff used
   * everywhere else. Toggling never touches git — it edits the renderer's
   * commit selection.
   */
  selectionActions?: SelectionActions
  /**
   * Rows currently selected in the file list. When more than one is selected
   * the pane shows a "multiple files selected" state instead of the focused
   * file's diff, which would otherwise be misleading. Defaults to a single
   * selection (normal diff).
   */
  selectedCount?: number
  /**
   * Hide the file path and status badge from the diff header, keeping only the
   * view controls. Used by the File History overlay, where the path already
   * lives in the overlay's own title — repeating it (and an "M" badge) here is
   * noise.
   */
  hidePath?: boolean
}

/** Annotation metadata: which change block a selection bar belongs to. */
interface BlockRef {
  blockIndex: number
}

/**
 * Human description of an LFS object's size across the diff: a single size,
 * or "old → new" when the change replaced the object. Sizes are of the real
 * LFS content, not the pointer file.
 */
function lfsSizeLabel(lfs: NonNullable<DiffPayload['lfs']>): string {
  const { oldSize, newSize } = lfs
  if (oldSize !== null && newSize !== null && oldSize !== newSize) {
    return `${formatBytes(oldSize)} → ${formatBytes(newSize)}`
  }
  const size = newSize ?? oldSize
  return size !== null ? formatBytes(size) : ''
}

/**
 * Plain-language description of a submodule (gitlink) change. A gitlink can
 * move to a new commit, be added or removed, or simply be dirty: its own
 * working tree has uncommitted changes while its HEAD stays put, which git
 * reports as the same sha on both sides with a `-dirty` suffix.
 */
function submoduleSummary(sub: NonNullable<DiffPayload['submodule']>): string {
  const { oldSha, newSha, dirty } = sub
  const moved = oldSha !== null && newSha !== null && oldSha !== newSha
  const dirtyNote = ' open it as a repository to review them.'
  if (moved) {
    return dirty
      ? `The submodule points at a different commit. It also has uncommitted changes of its own —${dirtyNote}`
      : 'The submodule points at a different commit.'
  }
  if (oldSha === null) return 'The submodule was added at this commit.'
  if (newSha === null) return 'The submodule was removed.'
  // Both sides present and equal: only the submodule's own working tree moved.
  return `The submodule has uncommitted changes —${dirtyNote}`
}

function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

function DiffViewerImpl({
  diff,
  loading,
  mode,
  wrap,
  theme,
  onModeChange,
  onWrapChange,
  selectionActions,
  selectedCount = 1,
  hidePath = false
}: Props) {
  const stats = useMemo(() => (diff?.patch ? countChanges(diff.patch) : null), [diff?.patch])
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
  // SVG ships both pixels and text: `imageAsCode` flips the pane to the
  // regular code diff. Per-file choice — a new selection goes back to pixels.
  const [imageAsCode, setImageAsCode] = useState(false)
  const diffPath = diff?.path
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffPath is the trigger, not a read — selecting a new file resets the toggle to pixels.
  useEffect(() => setImageAsCode(false), [diffPath])
  // Only SVG offers the toggle: main ships text contents alongside the image
  // exclusively for SVG. Keying off the patch would misfire on rename-only
  // rasters, whose patch is a textless rename header.
  const hasCodeView = !!diff?.image && diff.oldContents != null && diff.newContents != null
  const imageView = !!diff?.image && (!hasCodeView || !imageAsCode)
  // The image diff mode lives where Split/Unified does for text — one header
  // spot for "how do I view this diff", whatever the file type. Persisted
  // values are validated so a stale/garbage key can't blank the stage.
  const [imageModePref, setImageModePref] = usePersistentState<ImageDiffMode>(
    'gg.imageDiffMode',
    'side-by-side'
  )
  const imageMode = IMAGE_DIFF_MODES.some((m) => m.id === imageModePref)
    ? imageModePref
    : 'side-by-side'
  // Single-sided payloads (added/deleted) are previews — no modes to offer.
  const imageIsDiff = !!diff?.image && diff.image.old !== null && diff.image.new !== null
  // Most loads finish in a few ms — keep the previous diff on screen and swap
  // it for the new payload when it lands. The spinner only ever appears for
  // slow loads (huge files), never as a one-frame flash on every click.
  const spin = useSpinDelay(loading)

  const diffOptions = useMemo(
    () =>
      ({
        theme: theme === 'light' ? 'pierre-light' : 'pierre-dark',
        themeType: theme,
        diffStyle: mode,
        overflow: wrap ? 'wrap' : 'scroll',
        diffIndicators: 'bars',
        hunkSeparators: 'line-info-basic',
        lineDiffType: 'word',
        disableFileHeader: true,
        stickyHeader: false
      }) satisfies BaseDiffOptions,
    [theme, mode, wrap]
  )

  // Full file contents let us render an expandable diff (MultiFileDiff); without
  // them (binary / too large / unreadable) we fall back to the patch-only view.
  const canExpand = diff?.oldContents != null && diff?.newContents != null
  // A genuinely empty file (e.g. a freshly added 0-byte file) has no lines on
  // either side, so the diff renderer would paint a blank pane — show a clear
  // empty state instead.
  const isEmptyFile = canExpand && diff?.oldContents === '' && diff?.newContents === ''

  const oldFile = useMemo(
    () => ({ name: diff?.oldPath ?? diff?.path ?? '', contents: diff?.oldContents ?? '' }),
    [diff?.oldPath, diff?.path, diff?.oldContents]
  )
  const newFile = useMemo(
    () => ({ name: diff?.path ?? '', contents: diff?.newContents ?? '' }),
    [diff?.path, diff?.newContents]
  )

  // ── Change-block selection bars (Changes tab, tracked modified files) ─────
  // The displayed diff is parsed from the full contents; every contiguous
  // changed region gets its own bar (finer than hunks — the differ merges
  // nearby blocks into one hunk). Patches are rendered only when needed
  // (commit / discard); toggling is pure renderer state — no git, no waiting.
  const selectable =
    !!selectionActions && !!diff && canExpand && diff.status === 'modified' && !diff.oldPath
  const meta = useMemo(
    () => (selectable ? parseDiffFromFile(oldFile, newFile) : null),
    [selectable, oldFile, newFile]
  )
  const blocks = useMemo(() => (meta ? listChangeBlocks(meta) : []), [meta])
  const annotations = useMemo<DiffLineAnnotation<BlockRef>[]>(
    () => blocks.map((b) => ({ ...b.anchor, metadata: { blockIndex: b.index } })),
    [blocks]
  )

  const blockPatch = (blockIndex: number): string | null =>
    meta && diff && blocks[blockIndex] ? buildBlockPatch(diff.path, meta, blocks, blockIndex) : null

  const isBlockSelected = (blockIndex: number): boolean => {
    const sel = selectionActions?.selection ?? 'all'
    if (sel === 'all') return true
    if (sel === 'none') return false
    return sel.has(blockIndex)
  }

  // Gray out the lines of excluded blocks (checkbox off) so the diff still shows
  // the change but reads as "not in this commit". Pierre paints line backgrounds
  // in its shadow DOM, so we feed the rule through its `unsafeCSS` option; the
  // string is empty in the common all-included case, injecting nothing.
  const selection = selectionActions?.selection
  const fileDiffOptions = useMemo(() => {
    const isExcluded = (i: number) =>
      selection === 'all' || selection == null
        ? false
        : selection === 'none'
          ? true
          : !selection.has(i)
    const css = buildExcludedDiffCss(blocks, isExcluded)
    return css ? { ...diffOptions, unsafeCSS: css } : diffOptions
  }, [blocks, diffOptions, selection])

  const toggleBlock = (blockIndex: number) => {
    if (!meta || !selectionActions) return
    const next = new Map<number, string>()
    for (const b of blocks) {
      const selected = b.index === blockIndex ? !isBlockSelected(b.index) : isBlockSelected(b.index)
      if (selected) {
        const patch = blockPatch(b.index)
        if (patch) next.set(b.index, patch)
      }
    }
    selectionActions.onChange(next, blocks.length)
  }

  const renderSelectionBar = (annotation: DiffLineAnnotation<BlockRef>) => {
    const { blockIndex } = annotation.metadata
    const block = blocks[blockIndex]
    if (!block || !selectionActions) return null
    const selected = isBlockSelected(blockIndex)
    return (
      <div className="stage-bar" data-state={selected ? 'staged' : 'unstaged'}>
        <label className="stage-bar__check">
          <input
            type="checkbox"
            checked={selected}
            disabled={selectionActions.busy}
            onChange={() => toggleBlock(blockIndex)}
          />
          Include in commit
        </label>
        <span className="diff-stat">
          {block.newLines > 0 && <span className="diff-stat__add">+{block.newLines}</span>}
          {block.oldLines > 0 && <span className="diff-stat__del">−{block.oldLines}</span>}
        </span>
        <span className="stage-bar__spacer" />
        <button
          className="stage-bar__discard"
          disabled={selectionActions.busy}
          data-tip="Discard this change"
          onClick={() => {
            const patch = blockPatch(blockIndex)
            if (patch) setConfirmDiscard(patch)
          }}
        >
          <Icon.Undo size={12} />
        </button>
      </div>
    )
  }

  // A multi-selection has no single diff to show — the focused file's diff
  // would look like "the" selected file, so show a count instead.
  if (selectedCount > 1) {
    return (
      <div className="diff-pane">
        <div className="center-state">
          <div className="icon-ring">
            <Icon.Diff size={24} />
          </div>
          <h3>{selectedCount} files selected</h3>
          <p>Select a single file to see its diff here.</p>
        </div>
      </div>
    )
  }

  if (!diff && !loading) {
    return (
      <div className="diff-pane">
        <div className="center-state">
          <div className="icon-ring">
            <Icon.Diff size={24} />
          </div>
          <h3>No file selected</h3>
          <p>Pick a file from the Changes or History panel to see its diff here.</p>
        </div>
      </div>
    )
  }

  const { dir, name } = diff ? splitPath(diff.path) : { dir: '', name: '' }

  return (
    <div className="diff-pane">
      <div className="diff-head">
        {diff && !hidePath && (
          <>
            <div className="diff-head__path">
              <span
                className={`diff-head__badge st-${diff.status}`}
                data-tip={statusLabel(diff.status)}
              >
                {statusLetter(diff.status)}
              </span>
              <span className="diff-head__file" data-tip={diff.path} data-tip-overflow="">
                {dir && <span className="diff-head__dir">{dir}</span>}
                <span className="diff-head__name">{name}</span>
              </span>
            </div>
            {diff.oldPath && (
              <span className="diff-head__dir" data-tip={`renamed from ${diff.oldPath}`}>
                ← {splitPath(diff.oldPath).name}
              </span>
            )}
          </>
        )}
        <div className="diff-head__spacer" />
        {!imageView && stats && (stats.additions > 0 || stats.deletions > 0) && (
          <span className="diff-stat">
            <span className="diff-stat__add">+{stats.additions}</span>
            <span className="diff-stat__del">−{stats.deletions}</span>
          </span>
        )}
        {/* The same header spot answers "how do I view this diff" for every
            file type: image modes while pixels show, Split/Unified for text —
            icon + label, matching the text viewer's segments. */}
        {imageView && imageIsDiff && (
          <div className="segmented">
            {IMAGE_DIFF_MODES.map((m) => (
              <button
                key={m.id}
                className={imageMode === m.id ? 'is-active' : ''}
                onClick={() => setImageModePref(m.id)}
                data-tip={m.title ?? m.label}
              >
                {m.icon(15)} {m.label}
              </button>
            ))}
          </div>
        )}
        {!imageView && (
          <>
            <button
              className={`icon-btn${wrap ? ' is-active' : ''}`}
              title="Toggle line wrapping"
              onClick={() => onWrapChange(!wrap)}
            >
              <Icon.Wrap size={16} />
            </button>
            <div className="segmented">
              <button
                className={mode === 'split' ? 'is-active' : ''}
                onClick={() => onModeChange('split')}
                title="Split view"
              >
                <Icon.Split size={15} /> Split
              </button>
              <button
                className={mode === 'unified' ? 'is-active' : ''}
                onClick={() => onModeChange('unified')}
                title="Unified view"
              >
                <Icon.Unified size={15} /> Unified
              </button>
            </div>
          </>
        )}
        {/* SVG only: representation toggle (pixels ⇄ code). A single
            icon-button, last in the header — the right edge anchors it, so
            it never moves when the controls beside it change between
            representations. */}
        {hasCodeView && (
          <button
            className={`icon-btn${imageAsCode ? ' is-active' : ''}`}
            data-tip={imageAsCode ? 'View the rendered image' : 'View the underlying code'}
            onClick={() => setImageAsCode(!imageAsCode)}
          >
            <Icon.Code size={16} />
          </button>
        )}
      </div>

      <div className={`diff-body${imageView ? ' diff-body--image' : ''}`}>
        {spin && (
          <div className="center-state">
            <div className="spinner" />
          </div>
        )}
        {!spin && diff?.image && imageView && (
          <ImageDiffViewer key={diff.path} image={diff.image} mode={imageMode} />
        )}
        {!spin && diff && !imageView && diff.notice && (
          <div className="center-state">
            <div className="icon-ring">
              <Icon.Diff size={22} />
            </div>
            <h3>
              {diff.lfs
                ? `Git LFS file — ${statusLabel(diff.status).toLowerCase()}`
                : statusLabel(diff.status)}
            </h3>
            {diff.lfs && lfsSizeLabel(diff.lfs) && (
              <p className="diff-lfs-size">{lfsSizeLabel(diff.lfs)}</p>
            )}
            <p>{diff.notice}</p>
          </div>
        )}
        {!spin && diff && !imageView && !diff.notice && diff.submodule && (
          <div className="center-state">
            <div className="icon-ring">
              <Icon.Module size={22} />
            </div>
            <h3>Submodule {statusLabel(diff.status).toLowerCase()}</h3>
            <p className="submodule-move">
              {diff.submodule.oldSha !== null &&
              diff.submodule.newSha !== null &&
              diff.submodule.oldSha !== diff.submodule.newSha ? (
                <>
                  <code>{diff.submodule.oldSha.slice(0, 7)}</code>
                  <span aria-hidden>→</span>
                  <code>{diff.submodule.newSha.slice(0, 7)}</code>
                </>
              ) : (
                <code>{(diff.submodule.newSha ?? diff.submodule.oldSha)?.slice(0, 7)}</code>
              )}
            </p>
            <p>{submoduleSummary(diff.submodule)}</p>
          </div>
        )}
        {!spin && diff && !imageView && !diff.notice && !diff.submodule && isEmptyFile && (
          <div className="center-state">
            <div className="icon-ring">
              <Icon.Diff size={22} />
            </div>
            <h3>Empty file</h3>
            <p>This file has no content.</p>
          </div>
        )}
        {!spin &&
          diff &&
          !imageView &&
          !diff.notice &&
          !isEmptyFile &&
          diff.patch &&
          selectable &&
          meta && (
            <FileDiff<BlockRef>
              key={`${diff.path}:${theme}`}
              fileDiff={meta}
              lineAnnotations={annotations}
              renderAnnotation={renderSelectionBar}
              disableWorkerPool
              options={fileDiffOptions}
              style={{ minHeight: '100%' }}
            />
          )}
        {!spin &&
          diff &&
          !imageView &&
          !diff.notice &&
          !isEmptyFile &&
          diff.patch &&
          !selectable &&
          canExpand && (
            <MultiFileDiff
              key={`${diff.path}:${theme}`}
              oldFile={oldFile}
              newFile={newFile}
              disableWorkerPool
              options={diffOptions}
              style={{ minHeight: '100%' }}
            />
          )}
        {!spin &&
          diff &&
          !imageView &&
          !diff.notice &&
          !isEmptyFile &&
          diff.patch &&
          !selectable &&
          !canExpand && (
            <PatchDiff
              key={`${diff.path}:${theme}`}
              patch={diff.patch}
              disableWorkerPool
              options={diffOptions}
              style={{ minHeight: '100%' }}
            />
          )}
        {!spin &&
          diff &&
          !imageView &&
          !diff.notice &&
          !diff.submodule &&
          !isEmptyFile &&
          !diff.patch && (
            <div className="center-state">
              <div className="icon-ring">
                <Icon.Check size={22} />
              </div>
              <h3>No changes</h3>
              <p>This file has no textual differences to display.</p>
            </div>
          )}
      </div>

      {confirmDiscard && selectionActions && (
        <ConfirmDialog
          title="Discard this change?"
          danger
          body="The selected lines will be reverted in your working tree. This cannot be undone."
          confirmLabel="Discard"
          onConfirm={() => {
            const patch = confirmDiscard
            setConfirmDiscard(null)
            selectionActions.onDiscard(patch)
          }}
          onCancel={() => setConfirmDiscard(null)}
        />
      )}
    </div>
  )
}

// Memoized so the per-pixel `App` re-renders fired while dragging the sidebar
// splitter don't cascade into the (expensive) diff render. All props are
// referentially stable across a resize, so the memo bails out entirely.
export const DiffViewer = memo(DiffViewerImpl)
