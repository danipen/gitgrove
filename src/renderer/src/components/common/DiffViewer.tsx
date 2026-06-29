import { parseDiffFromFile } from '@pierre/diffs'
import type { BaseDiffOptions, DiffLineAnnotation } from '@pierre/diffs/react'
import { FileDiff, MultiFileDiff, PatchDiff } from '@pierre/diffs/react'
import type { DiffPayload } from '@shared/types'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  IMAGE_DIFF_MODES,
  type ImageDiffMode,
  ImageDiffViewer
} from '@/components/image/ImageDiffViewer'
import type { FileSelection } from '@/lib/commit-selection'
import { formatBytes, splitPath, statusLabel, statusLetter } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { usePersistentState } from '@/lib/persist'
import {
  blockLineKeys,
  buildBlockPatch,
  buildExcludedDiffCss,
  buildFileSelection,
  type ChangeBlock,
  type ChangedLine,
  lineKey,
  listBlockLines,
  listChangeBlocks
} from '@/lib/staging'
import type { ResolvedTheme } from '@/lib/theme'
import { useSpinDelay } from '@/lib/useSpinDelay'
import { ConfirmDialog } from './Dialog'

export type DiffMode = 'split' | 'unified'

/** Wiring for the change-block/line selection on working diffs. */
export interface SelectionActions {
  /** Current selection for the displayed file. */
  selection: FileSelection
  /** Replace the file's selection (already normalized to 'all'/'none'/blocks). */
  onChange: (selection: FileSelection) => void
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

type CheckState = 'checked' | 'indeterminate' | 'unchecked'

const EMPTY_SET: ReadonlySet<string> = new Set()

/**
 * The changed-line keys a block currently leaves *out* of the commit: none when
 * the file is fully in, all of them when it's fully out or the block is absent
 * from a partial map, else the block's stored exclusions.
 */
function excludedKeysFor(
  selection: FileSelection,
  blocks: ChangeBlock[],
  blockIndex: number
): ReadonlySet<string> {
  if (selection === 'all') return EMPTY_SET
  if (selection === 'none') return blockLineKeys(blocks[blockIndex])
  return selection.get(blockIndex)?.excluded ?? blockLineKeys(blocks[blockIndex])
}

/**
 * The per-line staging affordance, injected into pierre's shadow DOM via its
 * `unsafeCSS` option. Only a *changed* line is toggleable, so only its gutter
 * number gets the clickable cursor (pierre marks every number interactive once
 * `onLineNumberClick` is wired — we reset the rest back to the default arrow).
 * A check sits in a fixed column at the left of the gutter whenever the line is
 * in the commit, and vanishes once it's left out (excluded lines hide it via
 * `buildExcludedDiffCss` and gray their row). Every number cell reserves that
 * column with `padding-inline-start`, so the right-aligned number never reaches
 * the check whatever its width and the check stays put as digit counts change.
 * The check inherits the line-number color (green for additions, red for
 * deletions). Hovering the row brightens the check and lifts the number rect
 * with the hover tint, so the gutter feels clickable — a tick you can flip.
 * (Pierre draws its change-indicator bar as the cell's own `::before`, so the
 * check rides the cell's `::after` to leave that bar untouched.)
 */
const CHANGED_NUM =
  ':is([data-line-type="change-addition"],[data-line-type="change-deletion"])[data-column-number]'
const LINE_CHECKBOX_CSS =
  // Reserve the check column on every number cell so numbers stay aligned and
  // never collide with it; only changed numbers are clickable. Knob: the
  // padding is the column width.
  '[data-column-number]{cursor:default;position:relative;padding-inline-start:23px}' +
  `${CHANGED_NUM}{cursor:pointer}` +
  // The "in the commit" check, anchored at a fixed spot in that column. Dim at
  // rest so a calm gutter still reads as numbers; full on hover.
  `${CHANGED_NUM}::after{content:"✓";position:absolute;inset-inline-start:9px;inset-block-start:50%;` +
  'transform:translateY(-50%);font-size:1.1em;line-height:1;font-weight:700;' +
  'opacity:.55;transition:opacity .1s ease}' +
  // Hover: emphasize the check and deepen the number rect so it feels clickable.
  // An included line goes to its strong add/del color; an excluded one to strong
  // gray (set in buildExcludedDiffCss, which wins by source order). The emphasis
  // tint is only 15% opaque, so paint it *over* the line's opaque rest-state
  // background (`--diffs-bg-{addition,deletion}`) rather than replacing it — so
  // hovering visibly deepens the rect instead of washing it paler than rest.
  `${CHANGED_NUM}[data-hovered]::after{opacity:1}` +
  '[data-line-type="change-addition"][data-column-number][data-hovered]{background:' +
  'linear-gradient(var(--diffs-bg-addition-emphasis),var(--diffs-bg-addition-emphasis)) ' +
  'var(--diffs-bg-addition)}' +
  '[data-line-type="change-deletion"][data-column-number][data-hovered]{background:' +
  'linear-gradient(var(--diffs-bg-deletion-emphasis),var(--diffs-bg-deletion-emphasis)) ' +
  'var(--diffs-bg-deletion)}'

/**
 * Make the empty side of a hunk's *content* read as one continuous diagonal
 * hatch. Pierre hatches the content filler (`[data-content-buffer]`) per cell,
 * but a per-cell hatch can't be continuous — each filler anchors the pattern at
 * its own origin and steps out of phase at every seam.
 *
 * Instead paint the stripe on the content column *wrapper* (`[data-content]`,
 * which hugs the rows exactly — so the layer never overruns past the last line
 * the way the padded `[data-code]` panel does) and make the filler cells
 * transparent so they reveal one unbroken pattern. Real lines keep the opaque
 * `background-color` pierre gives them, so the hatch shows through *only* the
 * blanks. The number gutter is left to pierre's solid default — the hatch means
 * "no code on this side", which is the content column's message, not the number
 * rail's (and a solid rail keeps the per-line ✓ checks legible). The empty
 * mirror of the additions-side "Include in commit" bar is cleared only on
 * `[data-deletions]` so the bar's own side stays opaque (unified has no mirror).
 * Also for pierre's `unsafeCSS`.
 */
const CONTENT_HATCH =
  'background-color:var(--diffs-bg);background-size:8px 8px;background-origin:border-box;' +
  'background-repeat:repeat;background-image:repeating-linear-gradient(-45deg,transparent,' +
  'transparent calc(3px * 1.414),var(--diffs-bg-buffer) calc(3px * 1.414),' +
  'var(--diffs-bg-buffer) calc(4px * 1.414))'
const GUTTER_POLISH_CSS =
  `[data-content]{${CONTENT_HATCH}}` +
  ':is([data-content-buffer],[data-deletions] [data-line-annotation])' +
  '{background-color:transparent;background-image:none}'

/**
 * Pull the staging bar across the gutter↔content seam so its checkbox lands *in*
 * the gutter, lined up with the per-line ✓ checks — the way pierre's own "N
 * unmodified lines" separator spans the whole row, rather than a panel floating to
 * the right of a blank gutter. The `.stage-bar` is slotted into the *content* cell,
 * which sits under the sticky gutter (`z-index:3`), so two moves make it reach left:
 * (1) give each side a query container so the slotted bar can size itself to the
 * side's *visible* width with `100cqi` and offset itself left into the gutter (the
 * geometry lives in `.stage-bar`, changes.css); (2) lift the annotation row above
 * the gutter — `[data-content]` isn't a stacking context, so a z-index on the
 * annotation cell wins against the gutter within the shared `[data-code]` context.
 * Only the bar's own side — additions in split, the single column in unified; the
 * deletions mirror stays empty (cleared to hatch by GUTTER_POLISH_CSS above). The
 * bar paints its own `--bg-panel` across the gutter (no separate fill needed), and
 * because it's sized from the visible width it stays put while long lines scroll
 * under it — the gutter checkbox never drifts out of alignment on horizontal scroll.
 */
const STAGE_BAR_SPAN_CSS =
  '[data-code]{container-type:inline-size}' +
  ':is([data-additions],[data-unified]) [data-line-annotation]{position:relative;z-index:4}'

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

  // ── Change-block + line selection (Changes tab, tracked modified files) ───
  // The displayed diff is parsed from the full contents; every contiguous
  // changed region gets its own bar (finer than hunks — the differ merges
  // nearby blocks into one hunk), and every changed line gets its own gutter
  // checkbox underneath. Patches are rendered only when needed (commit /
  // discard); toggling is pure renderer state — no git, no waiting.
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
  // Which block owns each changed line — lets a gutter click find its block.
  const lineOwner = useMemo(() => {
    const owner = new Map<string, number>()
    for (const b of blocks) for (const l of listBlockLines(b)) owner.set(lineKey(l), b.index)
    return owner
  }, [blocks])

  const selection = selectionActions?.selection ?? 'all'
  const excludedFor = (blockIndex: number) => excludedKeysFor(selection, blocks, blockIndex)

  const blockCheck = (blockIndex: number): CheckState => {
    const excluded = excludedFor(blockIndex).size
    if (excluded === 0) return 'checked'
    return excluded >= listBlockLines(blocks[blockIndex]).length ? 'unchecked' : 'indeterminate'
  }

  // Recompute the file's selection after overriding one block's exclusions.
  const emit = (overrideBlock: number, excluded: ReadonlySet<string>) => {
    if (!meta || !diff || !selectionActions) return
    selectionActions.onChange(
      buildFileSelection(diff.path, meta, blocks, (i) =>
        i === overrideBlock ? excluded : excludedFor(i)
      )
    )
  }

  // Block bar: a fully-included block clears to "all out"; anything else
  // (partial or fully out) fills back to "all in".
  const toggleBlock = (blockIndex: number) =>
    emit(
      blockIndex,
      excludedFor(blockIndex).size === 0 ? blockLineKeys(blocks[blockIndex]) : EMPTY_SET
    )

  const toggleLine = (blockIndex: number, line: ChangedLine) => {
    const excluded = new Set(excludedFor(blockIndex))
    const key = lineKey(line)
    if (!excluded.delete(key)) excluded.add(key)
    emit(blockIndex, excluded)
  }

  // The whole-block patch (every line), used by discard regardless of selection.
  const blockPatch = (blockIndex: number): string | null =>
    meta && diff && blocks[blockIndex] ? buildBlockPatch(diff.path, meta, blocks, blockIndex) : null

  // A gutter click toggles its line. Kept behind a ref so the (stable) pierre
  // handler always sees the live selection without re-registering on every edit.
  const lineClickRef = useRef<(line: ChangedLine) => void>(() => {})
  lineClickRef.current = (line) => {
    if (selectionActions?.busy) return
    const blockIndex = lineOwner.get(lineKey(line))
    if (blockIndex !== undefined) toggleLine(blockIndex, line)
  }
  const onLineNumberClick = useMemo(
    () => (props: { lineType: string; lineNumber: number }) => {
      if (props.lineType === 'change-addition' || props.lineType === 'change-deletion')
        lineClickRef.current({ type: props.lineType, lineNumber: props.lineNumber })
    },
    []
  )

  // The lines to gray as "not in this commit" — fully-excluded blocks contribute
  // all their lines, partially-excluded ones just the deselected lines. Pierre
  // paints line backgrounds in its shadow DOM, so the rule (plus the per-line
  // checkbox affordance) rides in through its `unsafeCSS` option; both are empty
  // in the common all-included case, injecting nothing.
  const fileDiffOptions = useMemo(() => {
    const excludedLines: ChangedLine[] = []
    for (const b of blocks) {
      const excluded = excludedKeysFor(selection, blocks, b.index)
      if (excluded.size === 0) continue
      for (const l of listBlockLines(b)) if (excluded.has(lineKey(l))) excludedLines.push(l)
    }
    return {
      ...diffOptions,
      // Highlight only the line-number rect on hover (we restyle it ourselves
      // below), not the whole line.
      lineHoverHighlight: 'number' as const,
      onLineNumberClick,
      unsafeCSS: `${LINE_CHECKBOX_CSS}${GUTTER_POLISH_CSS}${STAGE_BAR_SPAN_CSS}${buildExcludedDiffCss(excludedLines)}`
    }
  }, [blocks, diffOptions, onLineNumberClick, selection])

  const renderSelectionBar = (annotation: DiffLineAnnotation<BlockRef>) => {
    const { blockIndex } = annotation.metadata
    const block = blocks[blockIndex]
    if (!block || !selectionActions) return null
    const check = blockCheck(blockIndex)
    // The stat counts only the lines actually going into the commit, so it
    // tracks the line checkboxes (a partly-selected block shows its real total).
    const excluded = excludedFor(blockIndex)
    let adds = 0
    let dels = 0
    for (const line of listBlockLines(block)) {
      if (excluded.has(lineKey(line))) continue
      if (line.type === 'change-addition') adds++
      else dels++
    }
    return (
      <div className="stage-bar" data-state={check}>
        <label className="stage-bar__check">
          <input
            type="checkbox"
            ref={(el) => {
              if (el) el.indeterminate = check === 'indeterminate'
            }}
            checked={check !== 'unchecked'}
            disabled={selectionActions.busy}
            onChange={() => toggleBlock(blockIndex)}
          />
          Include in commit
        </label>
        <span className="diff-stat">
          {adds > 0 && <span className="diff-stat__add">+{adds}</span>}
          {dels > 0 && <span className="diff-stat__del">−{dels}</span>}
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
