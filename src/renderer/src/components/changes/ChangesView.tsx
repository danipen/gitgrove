// The Changes sidebar: one list of changed files with commit-selection
// checkboxes (a master checkbox includes/excludes everything), an operation
// banner while a merge/rebase/cherry-pick/revert is in flight, stash access,
// and the commit composer. Checkboxes are pure renderer state — git is only
// touched at commit time. Destructive actions still go through `runOp`
// (serialized, auto-refresh, errors → toast).

import type { ChangedFile, FileStatus, RepoState, StashEntry } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContextMenuItem } from '@/components/common/ContextMenu'
import { copyPathItems } from '@/components/common/copyPathItems'
import { ConfirmDialog } from '@/components/common/Dialog'
import { type FileHistoryMode, fileHistoryItems } from '@/components/common/fileHistoryItems'
import { DEFAULT_FILTER_TYPES, useFileFilter } from '@/components/common/FileFilter'
import { Popover } from '@/components/common/Popover'
import { Resizer } from '@/components/common/Resizer'
import { WorkingFileList } from '@/components/common/WorkingFileList'
import type { FileSelection } from '@/lib/commit-selection'
import { pluralize, statusLetter } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { ignoreOptionsFor, ignoreSelectionOption } from '@/lib/ignore'
import { conflictActionLabels, mergeSourceFromDetail } from '@/lib/merge'
import { usePersistentState } from '@/lib/persist'
import type { ResolvedTheme } from '@/lib/theme'
import { CommitComposer, type CommitMode } from './CommitComposer'
import { StashPanel } from './StashPanel'
import { StashReminder } from './StashReminder'

interface Props {
  repoPath: string
  branch: string
  changes: ChangedFile[]
  loading: boolean
  busy: boolean
  repoState: RepoState | null
  stashes: StashEntry[]
  selectedPath: string | null
  /** Focus change; null when the list selection was emptied. */
  onSelectFile: (path: string | null) => void
  /** Reports the file-list selection size so the diff pane can show a
   *  "multiple files selected" state. */
  onFileSelectionChange?: (count: number) => void
  /** Commit selection per path; missing key = fully included. */
  selections: ReadonlyMap<string, FileSelection>
  /** Toggle one file's inclusion in the next commit (pure renderer state). */
  onToggleFile: (path: string) => void
  /** Master checkbox: include/exclude everything (or just `paths` when filtering). */
  onSetAllIncluded: (included: boolean, paths?: string[]) => void
  /** On-disk size of the included files (bytes), or null while unknown. */
  commitSize: number | null
  /** Determinate 0–100 of a running discard, or null before/without one. */
  discardProgress: number | null
  /** Resolved theme, for the stash review dialog's diff. */
  theme: ResolvedTheme
  /** Run a mutating op (serialized, auto-refresh, errors → toast). True on success. */
  runOp: (fn: () => Promise<unknown>) => Promise<boolean>
  /** Surface an error from a fire-and-forget action (e.g. no merge tool). */
  onError: (e: unknown) => void
  onCommit: (message: string, amend: boolean) => Promise<boolean>
  /** Stash the checked files (optional message). True on success. */
  onStash: (message: string) => Promise<boolean>
  /** Open the File History overlay for a working-tree file (baseRef = null). */
  onOpenFileHistory: (path: string, mode: FileHistoryMode, baseRef: string | null) => void
}

const OP_LABEL: Record<NonNullable<RepoState['op']>, string> = {
  merging: 'Merge in progress',
  rebasing: 'Rebase in progress',
  'cherry-picking': 'Cherry-pick in progress',
  reverting: 'Revert in progress'
}

/** Rows shown in the discard confirmation before collapsing to "+N more". */
const DISCARD_LIST_MAX = 250

/**
 * Discard confirmation body: exactly which files are about to be discarded
 * (scrollable, status-tinted), so a bulk discard is never a leap of faith —
 * and, once confirmed, a determinate bar while the discard runs.
 */
function DiscardSummary({
  files,
  all,
  progress
}: {
  files: ChangedFile[]
  all: boolean
  /** 0–100 while the discard runs; null before confirmation. */
  progress: number | null
}) {
  const untracked = files.filter((f) => f.status === 'untracked').length
  const overflow = files.length - DISCARD_LIST_MAX
  return (
    <>
      This will discard the {all ? 'unstaged ' : ''}changes in{' '}
      {files.length === 1 ? <code>{files[0].path}</code> : pluralize(files.length, 'file')}.
      <div className="discard-list" role="list">
        {files.slice(0, DISCARD_LIST_MAX).map((f) => (
          <div key={f.path} className="discard-list__row" role="listitem">
            <span className={`wfl__status st-${f.status}`}>{statusLetter(f.status)}</span>
            <span className="discard-list__path" title={f.path}>
              {f.path}
            </span>
          </div>
        ))}
        {overflow > 0 && (
          <div className="discard-list__more">…and {pluralize(overflow, 'more file')}</div>
        )}
      </div>
      {progress !== null ? (
        <div className="clone-progress" role="status">
          <div className="clone-progress__bar">
            <div className="clone-progress__fill" style={{ width: `${Math.max(2, progress)}%` }} />
          </div>
          <span className="clone-progress__label">Discarding… {progress}%</span>
        </div>
      ) : untracked > 0 ? (
        `Tracked files are restored from the last commit; ${
          untracked === files.length
            ? 'untracked files move'
            : `the ${pluralize(untracked, 'untracked file')} moves`
        } to the system trash, so this is recoverable.`
      ) : (
        'Files are restored to their state in the last commit.'
      )}
    </>
  )
}

export function ChangesView({
  repoPath,
  branch,
  changes,
  loading,
  busy,
  repoState,
  stashes,
  selectedPath,
  onSelectFile,
  onFileSelectionChange,
  selections,
  onToggleFile,
  onSetAllIncluded,
  commitSize,
  discardProgress,
  theme,
  runOp,
  onError,
  onCommit,
  onStash,
  onOpenFileHistory
}: Props) {
  const gg = window.gitgrove

  // What state the working tree is in: any in-flight op suspends the checkbox
  // commit model (the op owns what gets committed) and the discard actions
  // (discarding mid-merge half-destroys the merge in confusing ways).
  const op = repoState?.op ?? null
  const merging = op === 'merging'
  const conflicts = repoState?.conflictedCount ?? 0
  const mergeSource = merging ? mergeSourceFromDetail(repoState?.detail) : null

  // Changes GitGrove stashed on this branch when the user branched off with
  // "leave them on …" — greeted with the welcome-back reminder below.
  const leftStash = useMemo(
    () => stashes.find((s) => s.auto && s.branchName === branch),
    [stashes, branch]
  )

  // ── Filter (name substring + status types, shared with History) ───────────
  // The snapshot arrives path-sorted from the main process. Filtering and the
  // header stats are each a single memoized pass, so a 90k-entry list stays
  // cheap per refresh. A Conflicted chip joins the filter while conflicts
  // exist, so resolving them can be the only thing on screen.
  const hasConflictedFiles = useMemo(
    () => changes.some((f) => f.status === 'conflicted'),
    [changes]
  )
  const filterTypes = useMemo<readonly FileStatus[]>(
    () => (hasConflictedFiles ? ['conflicted', ...DEFAULT_FILTER_TYPES] : DEFAULT_FILTER_TYPES),
    [hasConflictedFiles]
  )

  // The configured merge.tool name, for the conflicted-file context menu —
  // its labels must match the conflict panel's exactly. Fetched only when
  // conflicts actually exist.
  const [mergeToolName, setMergeToolName] = useState<string | null>(null)
  useEffect(() => {
    if (!hasConflictedFiles) return
    let stale = false
    gg.mergeToolName(repoPath)
      .then((tool) => {
        if (!stale) setMergeToolName(tool)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [hasConflictedFiles, repoPath])
  const {
    filtered: files,
    query: filterQuery,
    active: filterActive,
    bar: filterBar
  } = useFileFilter(changes, filterTypes)

  const stats = useMemo(() => {
    let includedCount = 0
    let selectables = 0
    let fullyIncluded = 0
    let discardables = 0
    for (const f of files) {
      if (f.status !== 'conflicted') {
        selectables++
        const sel = selections.get(f.path) ?? 'all'
        if (sel !== 'none') includedCount++
        if (sel === 'all') fullyIncluded++
        // Submodule rows commit fine but can't be discarded: restoring a
        // gitlink means moving the submodule's own working tree, which the
        // discard machinery (checkout-index) doesn't do — so don't offer it.
        if (!f.submodule) discardables++
      }
    }
    return {
      includedCount,
      hasSelectables: selectables > 0,
      allIncluded: selectables > 0 && fullyIncluded === selectables,
      discardables
    }
  }, [files, selections])
  const { includedCount, hasSelectables, allIncluded } = stats

  const [confirmDiscard, setConfirmDiscard] = useState<{
    files: ChangedFile[]
    all: boolean
  } | null>(null)

  // Composer mode (Commit | Amend | Stash): the action button is a split
  // button whose caret half opens this popover to switch modes.
  const [mode, setMode] = useState<CommitMode>('commit')
  const [modeOpen, setModeOpen] = useState(false)
  const modeAnchor = useRef<HTMLButtonElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoPath is the intentional reset trigger
  useEffect(() => setMode('commit'), [repoPath])

  // An in-flight op forces plain commit mode: amending or stashing mid-merge
  // would corrupt the operation's state.
  useEffect(() => {
    if (op) setMode('commit')
  }, [op])

  const modeMeta = {
    commit: { label: 'Commit', sub: `Create a new commit on ${branch}`, MIcon: Icon.Check },
    amend: { label: 'Amend', sub: 'Replace the last commit with this one', MIcon: Icon.Pencil },
    stash: { label: 'Stash', sub: 'Set the checked files aside for later', MIcon: Icon.Stash }
  } as const

  // Height of the composer's description box, driven by the splitter above
  // the composer (the only stretchy part — everything else is fixed, so the
  // panel never jumps when switching modes). Live drags write to the DOM
  // node directly; state commits on release and persists across sessions.
  const [storedDescHeight, setDescHeight] = usePersistentState('gg.composerDescHeight', 96)
  const descHeight = Math.min(300, Math.max(30, storedDescHeight))
  const descEl = useRef<HTMLTextAreaElement | null>(null)

  // True while a confirmed discard runs — the dialog stays open showing the
  // determinate progress bar instead of vanishing into a frozen list.
  const [discarding, setDiscarding] = useState(false)

  const discard = async () => {
    if (!confirmDiscard) return
    // Tracked files carry oldPath/status so the main process can restore
    // renames and staged-new files to their HEAD state (see IPC.discardFiles).
    const tracked = confirmDiscard.files
      .filter((f) => f.status !== 'untracked')
      .map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status }))
    const untracked = confirmDiscard.files
      .filter((f) => f.status === 'untracked')
      .map((f) => f.path)
    setDiscarding(true)
    try {
      await runOp(() => gg.discardFiles(repoPath, tracked, untracked))
    } finally {
      setDiscarding(false)
      setConfirmDiscard(null)
    }
  }

  const confirmDiscardAll = () =>
    setConfirmDiscard({
      files: files.filter((f) => f.status !== 'conflicted' && !f.submodule),
      all: true
    })

  // Full (unfiltered) untracked list, so the Ignore menu counts reflect the
  // repo, not the current filter.
  const untrackedPaths = useMemo(
    () => changes.filter((f) => f.status === 'untracked').map((f) => f.path),
    [changes]
  )

  /** Ignore menu rows: each label names exactly what it hides (file, all
   *  same-extension files, folder) — no surprises, no dialog. The
   *  watcher-driven refresh makes the files vanish and `.gitignore` itself
   *  appear as a change, so the action is self-explaining and trivially
   *  undoable. */
  const ignoreItemsFor = (file: ChangedFile): ContextMenuItem[] =>
    ignoreOptionsFor(file.path, untrackedPaths).map((o) => ({
      label: o.label,
      icon: <Icon.EyeOff size={15} />,
      onClick: () => runOp(() => gg.ignorePatterns(repoPath, o.patterns))
    }))

  /** Menu for the list selection: single file keeps the full menu; a
   *  multi-selection gets bulk include/exclude, discard and copy. While an
   *  op is in flight the commit-selection and discard entries disappear —
   *  the op owns the working tree until it's completed or aborted. */
  const contextMenuFor = (selected: ChangedFile[]): ContextMenuItem[] => {
    if (selected.length > 1) {
      const actionable = selected.filter((f) => f.status !== 'conflicted')
      const items: ContextMenuItem[] = []
      if (actionable.length > 0 && !op) {
        const allIncluded = actionable.every((f) => (selections.get(f.path) ?? 'all') !== 'none')
        // Submodule rows commit fine but can't be discarded (see stats above).
        const discardable = actionable.filter((f) => !f.submodule)
        items.push(
          allIncluded
            ? {
                label: 'Exclude from Commit',
                icon: <Icon.Minus size={15} />,
                onClick: () =>
                  onSetAllIncluded(
                    false,
                    actionable.map((f) => f.path)
                  )
              }
            : {
                label: 'Include in Commit',
                icon: <Icon.Plus size={15} />,
                onClick: () =>
                  onSetAllIncluded(
                    true,
                    actionable.map((f) => f.path)
                  )
              },
          ...(discardable.length > 0
            ? [
                {
                  label: 'Discard Changes…',
                  icon: <Icon.Undo size={15} />,
                  danger: true,
                  onClick: () => setConfirmDiscard({ files: discardable, all: false })
                }
              ]
            : []),
          {}
        )
      }
      const untracked = selected.filter((f) => f.status === 'untracked')
      if (untracked.length > 0) {
        const option = ignoreSelectionOption(
          untracked.map((f) => f.path),
          selected.length
        )
        items.push(
          {
            label: option.label,
            icon: <Icon.EyeOff size={15} />,
            onClick: () => runOp(() => gg.ignorePatterns(repoPath, option.patterns))
          },
          {}
        )
      }
      items.push(...copyPathItems(selected, repoPath))
      return items
    }
    const file = selected[0]
    if (!file) return []
    if (file.status === 'conflicted') {
      // Exactly the conflict panel's labels and icons — one vocabulary for
      // resolving, wherever the user finds the action.
      const labels = conflictActionLabels({
        toolName: mergeToolName,
        ours: branch || null,
        theirs: mergeSource
      })
      return [
        {
          // Same hierarchy as the conflict panel: combining both sides in a
          // merge tool is the primary path, taking a side wholesale follows.
          // NOT through runOp — mergetool blocks until the tool closes, which
          // would hold `busy` (and the whole UI) for minutes.
          label: labels.tool,
          icon: <Icon.Merge size={15} />,
          onClick: () => gg.openMergeTool(repoPath, file.path).catch(onError)
        },
        {},
        {
          label: labels.ours,
          icon: <Icon.SideLeft size={15} />,
          onClick: () => runOp(() => gg.resolveConflict(repoPath, file.path, 'ours'))
        },
        {
          label: labels.theirs,
          icon: <Icon.SideRight size={15} />,
          onClick: () => runOp(() => gg.resolveConflict(repoPath, file.path, 'theirs'))
        },
        {},
        {
          label: labels.mark,
          icon: <Icon.Check size={15} />,
          onClick: () => runOp(() => gg.markResolved(repoPath, file.path))
        },
        {},
        {
          label: 'Open in Editor',
          icon: <Icon.External size={15} />,
          onClick: () => gg.openFileInEditor(repoPath, file.path)
        },
        {},
        ...copyPathItems([file], repoPath)
      ]
    }
    const included = (selections.get(file.path) ?? 'all') !== 'none'
    return [
      ...(op
        ? []
        : [
            included
              ? {
                  label: 'Exclude from Commit',
                  icon: <Icon.Minus size={15} />,
                  onClick: () => onToggleFile(file.path)
                }
              : {
                  label: 'Include in Commit',
                  icon: <Icon.Plus size={15} />,
                  onClick: () => onToggleFile(file.path)
                },
            // Submodule rows commit fine but can't be discarded (see stats above).
            ...(file.submodule
              ? []
              : [
                  {
                    label: file.status === 'untracked' ? 'Move to Trash…' : 'Discard Changes…',
                    icon: <Icon.Undo size={15} />,
                    danger: true,
                    onClick: () => setConfirmDiscard({ files: [file], all: false })
                  }
                ]),
            {}
          ]),
      ...(file.status === 'untracked' ? [...ignoreItemsFor(file), {}] : []),
      // Untracked files have no committed history to inspect.
      ...(file.status === 'untracked'
        ? []
        : [...fileHistoryItems(file, null, onOpenFileHistory), {}]),
      {
        label: 'Open in Editor',
        icon: <Icon.External size={15} />,
        onClick: () => gg.openFileInEditor(repoPath, file.path)
      },
      {},
      ...copyPathItems([file], repoPath)
    ]
  }

  return (
    <div className="changes">
      {op && (
        <div
          className={`op-banner ${conflicts > 0 ? 'op-banner--working' : 'op-banner--ready'}`}
          role="status"
        >
          <span className="op-banner__icon" aria-hidden>
            {conflicts > 0 ? <Icon.Merge size={15} /> : <Icon.Check size={15} />}
          </span>
          <div className="op-banner__text">
            <strong>
              {merging && mergeSource ? (
                <>
                  Merging <code>{mergeSource}</code> into <code>{branch}</code>
                </>
              ) : (
                OP_LABEL[op]
              )}
            </strong>
            <span>
              {conflicts > 0
                ? `${pluralize(conflicts, 'conflicted file')} to resolve — select a file marked ` +
                  'with the alert icon to fix it.'
                : merging
                  ? 'All conflicts resolved — complete the merge with the commit button below.'
                  : (repoState?.detail ?? 'All conflicts resolved — ready to continue.')}
            </span>
          </div>
          <div className="op-banner__actions">
            {/* A merge continues through the commit button — committing IS the
                continue — so the banner only offers the way out. */}
            {!merging && (
              <button
                className="btn-primary btn-primary--sm"
                disabled={busy || conflicts > 0}
                data-tip={conflicts > 0 ? 'Resolve all conflicts first' : undefined}
                onClick={() => runOp(() => gg.continueOp(repoPath, op))}
              >
                Continue
              </button>
            )}
            {op === 'rebasing' && (
              <button
                className="btn-ghost btn-ghost--sm"
                disabled={busy}
                data-tip="Skip the current commit"
                onClick={() => runOp(() => gg.skipRebaseCommit(repoPath))}
              >
                Skip
              </button>
            )}
            <button
              className="btn-ghost btn-ghost--sm"
              disabled={busy}
              data-tip={
                merging ? 'Undo the merge and return to the state before it started' : undefined
              }
              onClick={() => runOp(() => gg.abortOp(repoPath, op))}
            >
              Abort
            </button>
          </div>
        </div>
      )}

      {leftStash && !op && (
        <StashReminder
          repoPath={repoPath}
          stash={leftStash}
          busy={busy}
          theme={theme}
          runOp={runOp}
        />
      )}

      <div className="changes__list">
        {loading && changes.length === 0 ? (
          <div className="center-state">
            <div className="spinner" />
          </div>
        ) : changes.length === 0 ? (
          <div className="center-state">
            <div className="icon-ring">
              <Icon.Check size={22} />
            </div>
            <h3>Working tree clean</h3>
            <p>There are no uncommitted changes. Switch to History to browse past commits.</p>
          </div>
        ) : (
          <>
            <div className="section-head">
              {/* The checkbox commit model and bulk discard are suspended
                  while an op runs — the op owns what gets committed. */}
              {!op && (
                <input
                  type="checkbox"
                  className="wfl__check"
                  checked={allIncluded}
                  ref={(el) => {
                    if (el) el.indeterminate = !allIncluded && includedCount > 0
                  }}
                  disabled={busy || !hasSelectables}
                  data-tip={allIncluded ? 'Exclude all from commit' : 'Include all in commit'}
                  onChange={() =>
                    onSetAllIncluded(
                      !allIncluded,
                      filterActive
                        ? files.filter((f) => f.status !== 'conflicted').map((f) => f.path)
                        : undefined
                    )
                  }
                />
              )}
              <span className="section-head__label">
                {filterActive
                  ? `${files.length} of ${changes.length}`
                  : pluralize(files.length, 'file')}
              </span>
              <span className="section-head__spacer" />
              {stats.discardables > 0 && !op && (
                <button
                  className="section-head__action is-danger"
                  disabled={busy}
                  data-tip="Discard all unstaged changes"
                  onClick={confirmDiscardAll}
                >
                  <Icon.Undo size={13} />
                </button>
              )}
            </div>
            {filterBar}
            {files.length === 0 ? (
              <div className="list-empty">No changes match the filter.</div>
            ) : (
              <WorkingFileList
                key={repoPath}
                files={files}
                selections={op ? undefined : selections}
                selectedPath={selectedPath}
                onSelect={onSelectFile}
                onToggleIncluded={op ? undefined : onToggleFile}
                onSetIncluded={
                  op ? undefined : (paths, included) => onSetAllIncluded(included, paths)
                }
                highlight={filterQuery}
                onSelectionChange={onFileSelectionChange}
                contextMenuFor={contextMenuFor}
              />
            )}
          </>
        )}
      </div>

      <Resizer
        orientation="y"
        invert
        size={descHeight}
        min={30}
        max={300}
        onPreview={(h) => {
          if (descEl.current) descEl.current.style.height = `${h}px`
        }}
        onCommit={setDescHeight}
      />
      <StashPanel repoPath={repoPath} stashes={stashes} busy={busy} theme={theme} runOp={runOp} />

      <Popover
        anchor={modeAnchor.current}
        open={modeOpen}
        onClose={() => setModeOpen(false)}
        width={250}
      >
        <div className="popover__list">
          <div className="popover__group-label">Mode</div>
          {(['commit', 'amend', 'stash'] as const).map((m) => {
            const { label, sub, MIcon } = modeMeta[m]
            return (
              <button
                key={m}
                className={`popover__item${mode === m ? ' is-active' : ''}`}
                onClick={() => {
                  setMode(m)
                  setModeOpen(false)
                }}
              >
                <span className="icon-muted">
                  <MIcon size={15} />
                </span>
                <span className="popover__item-main">
                  <span className="popover__item-title">{label}</span>
                  <span className="popover__item-sub">{sub}</span>
                </span>
                {mode === m && (
                  <span className="icon-muted" style={{ color: 'var(--accent)' }}>
                    <Icon.Check size={15} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </Popover>

      <CommitComposer
        repoPath={repoPath}
        branch={branch}
        includedCount={includedCount}
        commitSize={commitSize}
        busy={busy}
        mode={mode}
        repoOp={op}
        conflicts={conflicts}
        mergeSource={mergeSource}
        descriptionHeight={descHeight}
        descriptionRef={(el) => {
          descEl.current = el
        }}
        modeMenuRef={(el) => {
          modeAnchor.current = el
        }}
        onOpenModeMenu={() => setModeOpen(true)}
        onCommit={async (message, withAmend) => {
          const ok = await onCommit(message, withAmend)
          if (ok) setMode('commit')
          return ok
        }}
        onStash={async (message) => {
          const ok = await onStash(message)
          if (ok) setMode('commit')
          return ok
        }}
      />

      {confirmDiscard && (
        <ConfirmDialog
          title={confirmDiscard.all ? 'Discard all changes?' : 'Discard changes?'}
          danger
          busy={discarding}
          body={
            <DiscardSummary
              files={confirmDiscard.files}
              all={confirmDiscard.all}
              progress={discarding ? (discardProgress ?? 0) : null}
            />
          }
          confirmLabel="Discard"
          onConfirm={discard}
          onCancel={() => setConfirmDiscard(null)}
        />
      )}
    </div>
  )
}
