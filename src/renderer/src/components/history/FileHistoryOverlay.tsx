import type { ChangedFile, Commit, DiffPayload } from '@shared/types'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { type DiffMode, DiffViewer } from '@/components/common/DiffViewer'
import { Resizer } from '@/components/common/Resizer'
import { useVirtualScroll, VScrollbar } from '@/components/common/VirtualScroll'
import { splitPath } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { usePersistentState } from '@/lib/persist'
import type { ResolvedTheme } from '@/lib/theme'
import { navTarget } from '@/lib/useListKeyNav'
import { useSpinDelay } from '@/lib/useSpinDelay'
import { Avatar } from './Avatar'
import { BlamePane } from './BlamePane'
import { CommitSummary } from './CommitSummary'

/** The two things the overlay can show for the file. */
export type FileHistoryMode = 'diff' | 'blame'

export interface FileHistoryTarget {
  /** Repo-relative path of the file. */
  path: string
  /** Which pane to open. */
  mode: FileHistoryMode
  /** Revision to anchor to: a commit hash (History tab) or null (Changes tab,
   *  i.e. the working tree). */
  baseRef: string | null
}

interface Props extends FileHistoryTarget {
  repoPath: string
  theme: ResolvedTheme
  onClose: () => void
}

/** Fixed commit-row height — mirrors `.fh-commit` in global.css. */
const FH_ROW_H = 58

/**
 * A full-window overlay (below the toolbar) answering "what happened to this
 * file?": the commits that touched it on the left, and a right pane that
 * toggles between the change in the selected commit (Diff, reusing DiffViewer)
 * and per-line authorship (Blame). Invoked from either file list's right-click
 * menu. Closes on the ✕ or Escape.
 */
export function FileHistoryOverlay({
  repoPath,
  path,
  mode: initialMode,
  baseRef,
  theme,
  onClose
}: Props) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<FileHistoryMode>(initialMode)
  // Anchor revision: the commit selected in the list, or null = working tree.
  const [selectedHash, setSelectedHash] = useState<string | null>(baseRef)
  // The working-tree row only makes sense when the file actually has
  // uncommitted changes. `baseRef === null` is passed exclusively from the
  // Changes tab, whose menu only appears on dirty working files — so it's our
  // signal that there's a working version worth showing (and selecting).
  const showWorkingTree = baseRef === null

  // The selected commit's files (drives the common summary header) and, in Diff
  // mode, the diff payload for this file.
  const [diff, setDiff] = useState<DiffPayload | null>(null)
  const [commitFiles, setCommitFiles] = useState<ChangedFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  // Split/Unified and wrap are app-global preferences (same keys the main diff
  // pane uses) so the choice is consistent everywhere and persists across runs.
  const [diffMode, setDiffMode] = usePersistentState<DiffMode>('gg.diffMode', 'split')
  const [wrap, setWrap] = usePersistentState('gg.diffWrap', false)
  // Width of the commit list, dragged via the splitter. Applied as a CSS var so
  // a drag mutates the DOM directly without re-rendering the list/diff.
  const [commitsWidth, setCommitsWidth] = usePersistentState('gg.fileHistory.commitsWidth', 320)
  const bodyRef = useRef<HTMLDivElement>(null)

  const spin = useSpinDelay(loading)
  const selectedCommit = commits.find((c) => c.hash === selectedHash) ?? null

  // Escape closes the overlay (alongside the ✕ button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Load the file's full commit timeline from HEAD (follows renames), so the
  // newest commit is the version currently checked out — it gets the "current"
  // badge. `baseRef` only chooses the initial selection, not the list scope.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.gitgrove
      .fileHistory(repoPath, path)
      .then((cs) => {
        if (cancelled) return
        setCommits(cs)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message || 'Failed to load file history.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repoPath, path])

  // Load what the right pane needs for the selection. `null` is the working
  // tree (the current on-disk state): no commit summary, and Diff mode shows
  // the uncommitted changes. For a commit we load its files (for the common
  // summary) plus, in Diff mode, this file's diff — matching by current/old
  // path then basename, since the name at an older commit can differ (rename).
  useEffect(() => {
    let cancelled = false
    setFilesLoading(true)
    ;(async () => {
      if (selectedHash == null) {
        setCommitFiles([])
        if (mode !== 'diff') {
          setDiff(null)
          setFilesLoading(false)
          return
        }
        const payload = await window.gitgrove.workingDiff(repoPath, {
          path,
          status: 'modified',
          staged: false
        })
        if (cancelled) return
        setDiff(payload)
        setFilesLoading(false)
        return
      }
      const files = await window.gitgrove.commitFiles(repoPath, selectedHash)
      if (cancelled) return
      setCommitFiles(files)
      if (mode !== 'diff') {
        setDiff(null)
        setFilesLoading(false)
        return
      }
      const name = splitPath(path).name
      const file =
        files.find((f) => f.path === path || f.oldPath === path) ??
        files.find((f) => splitPath(f.path).name === name)
      if (!file) {
        setDiff(null)
        setFilesLoading(false)
        return
      }
      const payload = await window.gitgrove.commitDiff(repoPath, selectedHash, file)
      if (cancelled) return
      setDiff(payload)
      setFilesLoading(false)
    })().catch(() => {
      if (!cancelled) {
        setDiff(null)
        setFilesLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mode, selectedHash, repoPath, path])

  const rowHeight = useCallback(() => FH_ROW_H, [])
  const vs = useVirtualScroll({ count: commits.length, rowHeight })

  // The list is the full history from HEAD, so a commit selected on open (from
  // the History tab) can sit far down — scroll it into view once it's loaded.
  const scrolledRef = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once after load; ensureVisible is stable.
  useEffect(() => {
    if (scrolledRef.current || commits.length === 0) return
    scrolledRef.current = true
    if (selectedHash == null) return
    const idx = commits.findIndex((c) => c.hash === selectedHash)
    if (idx >= 0) vs.ensureVisible(idx)
  }, [commits.length])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (commits.length === 0) return
    // The working tree (null) sits above commit[0]; arrow across the boundary.
    if (selectedHash == null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedHash(commits[0].hash)
      }
      return
    }
    const current = commits.findIndex((c) => c.hash === selectedHash)
    if (showWorkingTree && e.key === 'ArrowUp' && current === 0) {
      e.preventDefault()
      setSelectedHash(null)
      return
    }
    const page = Math.max(1, Math.floor(vs.viewportH / FH_ROW_H) - 1)
    const target = navTarget(e.key, current, commits.length, page)
    if (target === null) return
    e.preventDefault()
    if (target !== current) setSelectedHash(commits[target].hash)
  }

  return (
    <div className="file-history" role="dialog" aria-modal="true" aria-label={`History of ${path}`}>
      <div className="fh-head">
        <Icon.History size={15} />
        <span className="fh-head__title" data-tip={path} data-tip-overflow="">
          History of <code>{path}</code>
        </span>
        <span className="fh-head__spacer" />
        {mode === 'blame' && !selectedCommit && <span className="fh-head__hint">working tree</span>}
        {/* View switch lives in the overlay chrome — present in both modes and
            out of the content's way (it acts on the whole right pane). */}
        <div className="segmented">
          <button
            type="button"
            className={mode === 'diff' ? 'is-active' : ''}
            onClick={() => setMode('diff')}
            title="View the change in the selected commit"
          >
            <Icon.Diff size={15} /> Diff
          </button>
          <button
            type="button"
            className={mode === 'blame' ? 'is-active' : ''}
            onClick={() => setMode('blame')}
            title="Annotate each line with the commit that last changed it"
          >
            <Icon.History size={15} /> Blame
          </button>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)">
          <Icon.Close size={16} />
        </button>
      </div>

      <div
        className="fh-body"
        ref={bodyRef}
        style={{ '--fh-commits-w': `${commitsWidth}px` } as CSSProperties}
      >
        <div className="fh-commits">
          {/* The working tree (current, on-disk revision) is pinned at the top
              and selected by default — but only when the file has uncommitted
              changes, the way the current branch is marked in the branch list. */}
          {showWorkingTree && (
            <button
              type="button"
              className={`fh-commit fh-commit--wt${selectedHash === null ? ' is-active' : ''}`}
              onClick={() => setSelectedHash(null)}
            >
              <span className="fh-commit__wt-disc">
                <Icon.Changes size={14} />
              </span>
              <div className="fh-commit__main">
                <div className="fh-commit__subject">Working tree</div>
                <div className="fh-commit__meta">
                  <span className="fh-commit__author">Uncommitted changes</span>
                </div>
              </div>
            </button>
          )}
          {spin ? (
            <div className="center-state">
              <div className="spinner" />
            </div>
          ) : error ? (
            <div className="center-state">
              <div className="icon-ring">
                <Icon.History size={22} />
              </div>
              <h3>No history</h3>
              <p>{error}</p>
            </div>
          ) : commits.length === 0 ? (
            <div className="center-state">
              <div className="icon-ring">
                <Icon.History size={22} />
              </div>
              <h3>No history</h3>
              <p>This file has no commits yet.</p>
            </div>
          ) : (
            <div
              className="fh-commit-list"
              ref={vs.viewportRef}
              role="listbox"
              aria-label="File history"
              tabIndex={0}
              onKeyDown={handleKeyDown}
            >
              <div className="vlist__sizer" style={{ height: vs.totalHeight }} aria-hidden="true" />
              <div className="vlist__content" style={{ transform: `translateY(${-vs.top}px)` }}>
                {commits.slice(vs.start, vs.end).map((commit, i) => {
                  const idx = vs.start + i
                  const active = selectedHash === commit.hash
                  // The newest commit is the version currently checked out.
                  const current = idx === 0
                  return (
                    <button
                      key={commit.hash}
                      type="button"
                      className={`fh-commit${active ? ' is-active' : ''}`}
                      role="option"
                      aria-selected={active}
                      style={{
                        position: 'absolute',
                        top: vs.rowTop(idx),
                        left: 0,
                        right: 0
                      }}
                      onClick={() => {
                        vs.viewportEl?.focus()
                        setSelectedHash(commit.hash)
                      }}
                    >
                      <Avatar name={commit.authorName} email={commit.authorEmail} size={26} />
                      <div className="fh-commit__main">
                        <div className="fh-commit__subject">
                          <span
                            className="fh-commit__subject-text"
                            data-tip={commit.subject}
                            data-tip-overflow=""
                          >
                            {commit.subject}
                          </span>
                          {current && <span className="tag tag--current">current</span>}
                        </div>
                        <div className="fh-commit__meta">
                          <span className="fh-commit__author">{commit.authorName}</span>
                          <span className="fh-commit__when">· {commit.relativeDate}</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
              <VScrollbar vs={vs} />
            </div>
          )}
        </div>

        <Resizer
          orientation="x"
          size={commitsWidth}
          min={240}
          max={560}
          onPreview={(w) => bodyRef.current?.style.setProperty('--fh-commits-w', `${w}px`)}
          onCommit={setCommitsWidth}
        />

        <div className="fh-main">
          {/* The commit details panel is the shared context for both views. */}
          {selectedCommit && (
            <CommitSummary
              key={selectedCommit.hash}
              commit={selectedCommit}
              files={commitFiles}
              filesLoading={filesLoading}
            />
          )}

          {mode === 'blame' ? (
            <BlamePane
              key={`${selectedHash ?? 'wt'}:${path}`}
              repoPath={repoPath}
              path={path}
              baseRef={selectedHash}
              theme={theme}
            />
          ) : (
            <DiffViewer
              diff={diff}
              loading={filesLoading}
              mode={diffMode}
              wrap={wrap}
              theme={theme}
              onModeChange={setDiffMode}
              onWrapChange={setWrap}
            />
          )}
        </div>
      </div>
    </div>
  )
}
