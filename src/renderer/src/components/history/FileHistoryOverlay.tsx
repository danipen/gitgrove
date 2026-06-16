import type { ChangedFile, Commit, DiffPayload } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'
import { type DiffMode, DiffViewer } from '@/components/common/DiffViewer'
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

  // Diff-pane state for the selected commit.
  const [diff, setDiff] = useState<DiffPayload | null>(null)
  const [commitFiles, setCommitFiles] = useState<ChangedFile[]>([])
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffMode, setDiffMode] = usePersistentState<DiffMode>('gg.fileHistory.diffMode', 'unified')
  const [wrap, setWrap] = usePersistentState('gg.fileHistory.wrap', false)

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

  // Load the file's commit timeline (follows renames).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.gitgrove
      .fileHistory(repoPath, path, baseRef ?? undefined)
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
  }, [repoPath, path, baseRef])

  // Diff needs a concrete commit — pick the newest once history lands.
  useEffect(() => {
    if (mode === 'diff' && selectedHash == null && commits.length > 0) {
      setSelectedHash(commits[0].hash)
    }
  }, [mode, selectedHash, commits])

  // Load the selected commit's change for this file. The file's name at an
  // older commit can differ (rename), so match by current path or old path,
  // then fall back to the basename.
  useEffect(() => {
    if (mode !== 'diff' || selectedHash == null) {
      setDiff(null)
      setCommitFiles([])
      return
    }
    let cancelled = false
    setDiffLoading(true)
    ;(async () => {
      const files = await window.gitgrove.commitFiles(repoPath, selectedHash)
      if (cancelled) return
      setCommitFiles(files)
      const name = splitPath(path).name
      const file =
        files.find((f) => f.path === path || f.oldPath === path) ??
        files.find((f) => splitPath(f.path).name === name)
      if (!file) {
        setDiff(null)
        setDiffLoading(false)
        return
      }
      const payload = await window.gitgrove.commitDiff(repoPath, selectedHash, file)
      if (cancelled) return
      setDiff(payload)
      setDiffLoading(false)
    })().catch(() => {
      if (!cancelled) {
        setDiff(null)
        setDiffLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mode, selectedHash, repoPath, path])

  const rowHeight = useCallback(() => FH_ROW_H, [])
  const vs = useVirtualScroll({ count: commits.length, rowHeight })

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (commits.length === 0) return
    const page = Math.max(1, Math.floor(vs.viewportH / FH_ROW_H) - 1)
    const current = commits.findIndex((c) => c.hash === selectedHash)
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
        <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)">
          <Icon.Close size={16} />
        </button>
      </div>

      <div className="fh-body">
        <div className="fh-commits">
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
                  const active = selectedHash === commit.hash
                  return (
                    <button
                      key={commit.hash}
                      type="button"
                      className={`fh-commit${active ? ' is-active' : ''}`}
                      role="option"
                      aria-selected={active}
                      style={{
                        position: 'absolute',
                        top: vs.rowTop(vs.start + i),
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
                        <div
                          className="fh-commit__subject"
                          data-tip={commit.subject}
                          data-tip-overflow=""
                        >
                          {commit.subject}
                        </div>
                        <div className="fh-commit__meta">
                          <span className="fh-commit__author">{commit.authorName}</span>
                          <span>· {commit.relativeDate}</span>
                          <span className="commit__hash">· {commit.shortHash}</span>
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

        <div className="fh-main">
          <div className="fh-toolbar">
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
            {mode === 'blame' && (
              <span className="fh-toolbar__hint">
                {selectedCommit ? `at ${selectedCommit.shortHash}` : 'working tree'}
              </span>
            )}
          </div>

          {mode === 'blame' ? (
            <BlamePane
              key={`${selectedHash ?? 'wt'}:${path}`}
              repoPath={repoPath}
              path={path}
              baseRef={selectedHash}
              theme={theme}
            />
          ) : (
            <>
              {selectedCommit && (
                <CommitSummary
                  key={selectedCommit.hash}
                  commit={selectedCommit}
                  files={commitFiles}
                  filesLoading={diffLoading}
                />
              )}
              <DiffViewer
                diff={diff}
                loading={diffLoading}
                mode={diffMode}
                wrap={wrap}
                theme={theme}
                onModeChange={setDiffMode}
                onWrapChange={setWrap}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
