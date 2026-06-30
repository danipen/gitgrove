// The conflict-resolution panel: replaces the diff pane when a conflicted
// file is selected. Resolving a conflict should feel like a guided choice,
// not an emergency. One split button carries the whole flow: its primary
// half always names the single best next step — the user's merge tool while
// conflict markers remain (a conflicted file usually needs both sides
// combined), flipping to "Mark as Resolved" once the file is clean on disk —
// and the caret menu holds the alternatives (take ours/theirs wholesale,
// mark as-is). Same split-button pattern as the commit composer.
//
// Understanding a conflict means three comparisons, so the diff offers all
// of them: what the incoming branch changed (base → theirs, the default —
// your own work you already know), what your branch changed (base → ours),
// and where they disagree (ours ↔ theirs).

import type { BaseDiffOptions } from '@pierre/diffs/react'
import { MultiFileDiff } from '@pierre/diffs/react'
import type { ChangedFile, ConflictSides } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover } from '@/components/common/Popover'
import { pluralize, splitPath } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { conflictActionLabels } from '@/lib/merge'
import { usePersistentState } from '@/lib/persist'
import { pierreThemeFor, type ResolvedTheme } from '@/lib/theme'

interface Props {
  repoPath: string
  /** The conflicted file. A fresh object per snapshot — its identity is the
   *  re-fetch trigger, so external edits (editor, merge tool) stay in sync. */
  file: ChangedFile
  /** Current branch — the "ours" side. */
  ours: string
  /** Branch being merged in, when known from the merge message. */
  theirs: string | null
  theme: ResolvedTheme
  busy: boolean
  /** Run a mutating op (serialized, auto-refresh, errors → toast). */
  runOp: (fn: () => Promise<unknown>) => Promise<boolean>
  onError: (e: unknown) => void
}

/** Which pair of versions the diff shows — same ours/theirs vocabulary as
 *  the resolve actions. */
type ConflictView = 'theirs' | 'ours' | 'sides'

export function ConflictPanel({
  repoPath,
  file,
  ours,
  theirs,
  theme,
  busy,
  runOp,
  onError
}: Props) {
  const gg = window.gitgrove
  const [sides, setSides] = useState<ConflictSides | null>(null)
  // The configured merge.tool name, surfaced on the primary action so the
  // button says exactly what will open. null = git will auto-pick.
  const [toolName, setToolName] = useState<string | null>(null)
  // True while the external merge tool runs — it can take minutes and must
  // not hold the app's `busy` flag (it doesn't touch the write queue either).
  const [toolBusy, setToolBusy] = useState(false)
  const [view, setView] = usePersistentState<ConflictView>('gg.conflictView', 'theirs')
  // The split button's caret menu (alternative ways to resolve).
  const [menuOpen, setMenuOpen] = useState(false)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  // Stale-response guard: selecting another conflict mid-fetch must not let
  // the slow result overwrite the new file's sides.
  const req = useRef(0)

  useEffect(() => {
    const id = ++req.current
    gg.conflictSides(repoPath, file.path)
      .then((s) => {
        if (id === req.current) setSides(s)
      })
      .catch(() => {
        if (id === req.current) setSides(null)
      })
  }, [repoPath, file])

  useEffect(() => {
    gg.mergeToolName(repoPath)
      .then(setToolName)
      .catch(() => setToolName(null))
  }, [repoPath])

  const diffOptions = useMemo(
    () =>
      ({
        theme: pierreThemeFor(theme),
        themeType: theme,
        diffStyle: 'split',
        diffIndicators: 'bars',
        hunkSeparators: 'line-info-basic',
        lineDiffType: 'word',
        disableFileHeader: true,
        stickyHeader: false
      }) satisfies BaseDiffOptions,
    [theme]
  )

  const { dir, name } = splitPath(file.path)
  const theirsLabel = theirs ?? 'the incoming branch'
  const labels = conflictActionLabels({ toolName, ours, theirs })
  const resolvedOnDisk = sides !== null && !sides.binary && sides.markerCount === 0

  // Which comparisons are possible: base-relative views need the common
  // ancestor (a file added on both sides has none) plus that side's content.
  const canTheirs = sides?.base != null && sides?.theirs != null
  const canOurs = sides?.base != null && sides?.ours != null
  const canSides = sides?.ours != null && sides?.theirs != null
  const viewAvailable: Record<ConflictView, boolean> = {
    theirs: canTheirs,
    ours: canOurs,
    sides: canSides
  }
  const activeView: ConflictView | null = viewAvailable[view]
    ? view
    : canTheirs
      ? 'theirs'
      : canOurs
        ? 'ours'
        : canSides
          ? 'sides'
          : null

  /** The old/new pair and its header labels for the active view. */
  const pair =
    sides === null || activeView === null
      ? null
      : activeView === 'theirs'
        ? {
            old: sides.base ?? '',
            new: sides.theirs ?? '',
            oldLabel: <>Base — before both branches</>,
            newLabel: (
              <>
                Theirs — <code>{theirsLabel}</code>
              </>
            )
          }
        : activeView === 'ours'
          ? {
              old: sides.base ?? '',
              new: sides.ours ?? '',
              oldLabel: <>Base — before both branches</>,
              newLabel: (
                <>
                  Ours — <code>{ours}</code>
                </>
              )
            }
          : {
              old: sides.ours ?? '',
              new: sides.theirs ?? '',
              oldLabel: (
                <>
                  Ours — <code>{ours}</code>
                </>
              ),
              newLabel: (
                <>
                  Theirs — <code>{theirsLabel}</code>
                </>
              )
            }

  const resolve = (side: 'ours' | 'theirs') =>
    runOp(() => gg.resolveConflict(repoPath, file.path, side))

  const openMergeTool = () => {
    setToolBusy(true)
    gg.openMergeTool(repoPath, file.path)
      .catch(onError)
      .finally(() => setToolBusy(false))
  }

  return (
    <div className="conflict-pane">
      <div className="conflict-head">
        <span className="conflict-head__badge">
          <Icon.Merge size={14} />
        </span>
        <span className="conflict-head__file" data-tip={file.path} data-tip-overflow="">
          {dir && <span className="conflict-head__dir">{dir}</span>}
          <span className="conflict-head__name">{name}</span>
        </span>
        {sides !== null && !sides.binary && (
          <span
            className={`conflict-chip${resolvedOnDisk ? ' conflict-chip--clear' : ''}`}
            data-tip={
              resolvedOnDisk
                ? 'No conflict markers left in the file'
                : 'Unresolved <<<<<<< regions in the file'
            }
          >
            {resolvedOnDisk ? 'no markers left' : pluralize(sides.markerCount, 'conflict region')}
          </span>
        )}
      </div>

      <p className="conflict-intro">
        <code>{ours}</code> and <code>{theirsLabel}</code> both changed this file. Combine them in
        your merge tool — the arrow menu has the other ways to resolve.
      </p>

      <div className="conflict-tools">
        {/* One split button carries the resolution: the primary half is the
            single best next step (merge tool → mark-as-resolved once the
            file is clean on disk), the caret holds the alternatives. */}
        <div className="conflict-resolve">
          <button
            className="btn-primary btn-primary--sm conflict-resolve__main"
            disabled={busy || toolBusy}
            data-tip={
              resolvedOnDisk
                ? 'Stage the file exactly as saved on disk'
                : toolName
                  ? `Opens ${toolName} to combine both versions`
                  : 'Opens your git merge tool to combine both versions'
            }
            onClick={
              resolvedOnDisk
                ? () => runOp(() => gg.markResolved(repoPath, file.path))
                : openMergeTool
            }
          >
            {toolBusy ? (
              <span className="about__spinner" aria-hidden />
            ) : resolvedOnDisk ? (
              <Icon.Check size={13} />
            ) : (
              <Icon.Merge size={13} />
            )}
            {resolvedOnDisk ? labels.mark : labels.tool}
          </button>
          <button
            ref={menuAnchor}
            type="button"
            className="conflict-resolve__caret"
            disabled={busy || toolBusy}
            aria-haspopup="menu"
            aria-label="More ways to resolve"
            data-tip="More ways to resolve"
            onClick={() => setMenuOpen(true)}
          >
            <Icon.Chevron size={12} />
          </button>
        </div>
        <button
          className="btn-ghost btn-ghost--sm"
          disabled={busy}
          onClick={() => gg.openFileInEditor(repoPath, file.path).catch(onError)}
        >
          <Icon.External size={13} /> Open in Editor
        </button>
        <span className="conflict-tools__spacer" />
        {sides !== null && activeView !== null && (
          /* Same ours/theirs vocabulary as the resolve actions. */
          <div className="segmented">
            <button
              className={activeView === 'theirs' ? 'is-active' : ''}
              disabled={!canTheirs}
              data-tip={`What theirs (${theirsLabel}) changed since the common base`}
              onClick={() => setView('theirs')}
            >
              Theirs
            </button>
            <button
              className={activeView === 'ours' ? 'is-active' : ''}
              disabled={!canOurs}
              data-tip={`What ours (${ours}) changed since the common base`}
              onClick={() => setView('ours')}
            >
              Ours
            </button>
            <button
              className={activeView === 'sides' ? 'is-active' : ''}
              disabled={!canSides}
              data-tip="Where ours and theirs disagree"
              onClick={() => setView('sides')}
            >
              Side by side
            </button>
          </div>
        )}
      </div>

      <Popover
        anchor={menuAnchor.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        width={290}
      >
        {/* The alternatives to the button's current primary action — never a
            duplicate of it. The merge tool only appears here once the primary
            has flipped to Mark as Resolved, so it stays reachable. */}
        <div className="popover__list">
          <div className="popover__group-label">Other ways to resolve</div>
          {resolvedOnDisk && (
            <>
              <button
                className="popover__item"
                onClick={() => {
                  setMenuOpen(false)
                  openMergeTool()
                }}
              >
                <span className="icon-muted">
                  <Icon.Merge size={15} />
                </span>
                <span className="popover__item-main">
                  <span className="popover__item-title">{labels.tool}</span>
                  <span className="popover__item-sub">
                    {toolName
                      ? 'Combine both versions in the external tool'
                      : 'Opens your configured git merge tool'}
                  </span>
                </span>
              </button>
              <div className="popover__sep" role="separator" />
            </>
          )}
          <button
            className="popover__item"
            onClick={() => {
              setMenuOpen(false)
              resolve('ours')
            }}
          >
            <span className="icon-muted">
              <Icon.SideLeft size={15} />
            </span>
            <span className="popover__item-main">
              <span className="popover__item-title">{labels.ours}</span>
              <span className="popover__item-sub">
                {sides?.oursDeleted
                  ? `Deletes the file — ${ours} removed it`
                  : 'Keep your version of the file'}
              </span>
            </span>
          </button>
          <button
            className="popover__item"
            onClick={() => {
              setMenuOpen(false)
              resolve('theirs')
            }}
          >
            <span className="icon-muted">
              <Icon.SideRight size={15} />
            </span>
            <span className="popover__item-main">
              <span className="popover__item-title">{labels.theirs}</span>
              <span className="popover__item-sub">
                {sides?.theirsDeleted
                  ? `Deletes the file — ${theirsLabel} removed it`
                  : 'Take the incoming version of the file'}
              </span>
            </span>
          </button>
          {!resolvedOnDisk && (
            <>
              <div className="popover__sep" role="separator" />
              <button
                className="popover__item"
                onClick={() => {
                  setMenuOpen(false)
                  runOp(() => gg.markResolved(repoPath, file.path))
                }}
              >
                <span className="icon-muted">
                  <Icon.Check size={15} />
                </span>
                <span className="popover__item-main">
                  <span className="popover__item-title">{labels.mark}</span>
                  <span className="popover__item-sub">
                    Careful — conflict markers are still in the file
                  </span>
                </span>
              </button>
            </>
          )}
        </div>
      </Popover>

      <div className="conflict-body">
        {sides === null ? (
          <div className="center-state">
            <div className="spinner" />
          </div>
        ) : pair !== null ? (
          <>
            <div className="conflict-sides-labels" aria-hidden="true">
              <span>{pair.oldLabel}</span>
              <span>{pair.newLabel}</span>
            </div>
            <div className="conflict-diff">
              <MultiFileDiff
                key={`${file.path}:${activeView}:${theme}`}
                oldFile={{ name: file.path, contents: pair.old }}
                newFile={{ name: file.path, contents: pair.new }}
                disableWorkerPool
                options={diffOptions}
                style={{ minHeight: '100%' }}
              />
            </div>
          </>
        ) : sides.binary ? (
          <div className="center-state">
            <div className="icon-ring">
              <Icon.Diff size={22} />
            </div>
            <h3>Binary file</h3>
            <p>The versions can’t be compared as text — pick a side or use the merge tool.</p>
          </div>
        ) : sides.oursDeleted || sides.theirsDeleted ? (
          <div className="center-state">
            <div className="icon-ring">
              <Icon.Alert size={22} />
            </div>
            <h3>Changed on one side, deleted on the other</h3>
            <p>
              <code>{sides.oursDeleted ? ours : theirsLabel}</code> deleted this file while{' '}
              <code>{sides.oursDeleted ? theirsLabel : ours}</code> changed it. Choose above whether
              to keep the changed file or delete it.
            </p>
          </div>
        ) : (
          <div className="center-state">
            <div className="icon-ring">
              <Icon.Diff size={22} />
            </div>
            <h3>Too large to compare</h3>
            <p>The versions are too large to show here — pick a side or use the merge tool.</p>
          </div>
        )}
      </div>
    </div>
  )
}
