import type { ChangedFile, Commit } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { copyPathItems } from '@/components/common/copyPathItems'
import { useFileFilter } from '@/components/common/FileFilter'
import { Resizer } from '@/components/common/Resizer'
import { useVirtualScroll, VScrollbar } from '@/components/common/VirtualScroll'
import { WorkingFileList } from '@/components/common/WorkingFileList'
import { coAuthorsOf } from '@/lib/coauthors'
import { parseRefs, pluralize } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { usePersistentState } from '@/lib/persist'
import { navTarget } from '@/lib/useListKeyNav'
import { useSpinDelay } from '@/lib/useSpinDelay'
import { AvatarStack } from './AvatarStack'
import { RefChip } from './CommitSummary'

interface Props {
  repoPath: string
  commits: Commit[]
  loading: boolean
  selectedCommit: Commit | null
  onSelectCommit: (commit: Commit) => void
  commitFiles: ChangedFile[]
  commitFilesLoading: boolean
  selectedFilePath: string | null
  onSelectFile: (path: string) => void
  /** Reports the file-list selection size so the diff pane can show a
   *  "multiple files selected" state. */
  onFileSelectionChange?: (count: number) => void
  /** Right-click menu builder for a commit row (checkout, cherry-pick, reset, …). */
  commitMenuFor?: (commit: Commit) => ContextMenuItem[]
  /** Whether older commits exist past the loaded window (shows the sentinel). */
  hasMore?: boolean
  /** True while the next page is being fetched (bottom spinner). */
  loadingMore?: boolean
  /** Called when the list scrolls near the bottom; the parent appends a page. */
  onLoadMore?: () => void
}

/** How many ref chips to show inline in the list before collapsing to "+N". */
const MAX_LIST_REFS = 2

// Commit rows come in exactly two heights — refs stay on a single line (capped
// to "+N") so a commit carrying branches/tags is just one row taller. These
// mirror `.commit` in global.css; keep them in sync if the row padding changes.
const COMMIT_ROW_H = 51
const COMMIT_ROW_REFS_H = 69
/** Space reserved below the last row for the "load older commits" spinner. */
const MORE_ROW_H = 44
/** Page in the next batch once the window is within this many rows of the end. */
const PREFETCH_ROWS = 12

const hasRefs = (commit: Commit) => parseRefs(commit.refs).length > 0

export function HistoryView({
  repoPath,
  commits,
  loading,
  selectedCommit,
  onSelectCommit,
  commitFiles,
  commitFilesLoading,
  selectedFilePath,
  onSelectFile,
  onFileSelectionChange,
  commitMenuFor,
  hasMore,
  loadingMore,
  onLoadMore
}: Props) {
  const [filesHeight, setFilesHeight] = usePersistentState('gg.historyFilesHeight', 360)
  // Commit files usually load in a few ms — render a quiet blank panel during
  // that window instead of flashing a spinner; the spinner is for slow loads.
  const filesSpin = useSpinDelay(commitFilesLoading)
  // Right-clicked commit: cursor position + menu items for that commit.
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  // Name + type filter over the selected commit's files (same UI as Changes;
  // history has no untracked entries). Cleared when another commit is picked.
  const {
    filtered: visibleFiles,
    query: filterQuery,
    active: filterActive,
    bar: filterBar,
    reset: resetFilter
  } = useFileFilter(commitFiles, ['added', 'modified', 'deleted', 'renamed'])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the commit switch is the intentional trigger
  useEffect(() => resetFilter(), [selectedCommit?.hash])
  // Height is applied to this node directly while dragging (see Resizer.onPreview)
  // so resizing the commit-files panel never re-renders the history list.
  const filesRef = useRef<HTMLDivElement>(null)

  // Windowed rendering: only the visible commit rows (plus a small overscan)
  // live in the DOM, so a deep history (the unity repo loads 800k+ commits, a
  // page at a time) stays at a few dozen nodes instead of growing without
  // bound. Rows are one of two fixed heights; the table is rebuilt only when a
  // page is appended, so the height fn must be stable across scroll renders.
  const rowHeight = useCallback(
    (i: number) => (hasRefs(commits[i]) ? COMMIT_ROW_REFS_H : COMMIT_ROW_H),
    [commits]
  )
  const vs = useVirtualScroll({
    count: commits.length,
    rowHeight,
    // Leave room under the last row for the "load older commits" spinner.
    padBottom: hasMore ? MORE_ROW_H : 0
  })

  // Selecting a commit reveals the files panel below the list, which shrinks the
  // scroll viewport — the active row can end up below the fold. Nudge it back
  // into view; re-runs on viewport height changes (panel open / resize) too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the hash + viewport height are the intentional triggers; ensureVisible is stable.
  useEffect(() => {
    if (!selectedCommit) return
    const idx = commits.findIndex((c) => c.hash === selectedCommit.hash)
    if (idx >= 0) vs.ensureVisible(idx)
  }, [selectedCommit?.hash, vs.viewportH])

  // Infinite scroll: page in the next batch once the rendered window comes
  // within PREFETCH_ROWS of the last loaded commit. Re-runs as each page is
  // appended, so a tall viewport keeps filling itself with no scrolling. The
  // callback lives in a ref so this effect never depends on its identity.
  const onLoadMoreRef = useRef(onLoadMore)
  onLoadMoreRef.current = onLoadMore
  useEffect(() => {
    if (hasMore && vs.end >= commits.length - PREFETCH_ROWS) onLoadMoreRef.current?.()
  }, [hasMore, vs.end, commits.length])

  // Keyboard navigation: arrows / PageUp / PageDown / Home / End move the
  // selection (selection follows focus, exactly like the file lists). The
  // handler lives on the scroll container; the effect above keeps the new
  // selection on screen.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (commits.length === 0) return
    const page = Math.max(1, Math.floor(vs.viewportH / COMMIT_ROW_H) - 1)
    const current = selectedCommit ? commits.findIndex((c) => c.hash === selectedCommit.hash) : -1
    const target = navTarget(e.key, current, commits.length, page)
    if (target === null) return
    e.preventDefault()
    if (target !== current) onSelectCommit(commits[target])
  }

  if (loading && commits.length === 0) {
    return (
      <div className="center-state">
        <div className="spinner" />
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div className="center-state">
        <div className="icon-ring">
          <Icon.History size={22} />
        </div>
        <h3>No history</h3>
        <p>This branch doesn’t have any commits yet.</p>
      </div>
    )
  }

  return (
    <div className="history">
      <div
        className="commit-list"
        ref={vs.viewportRef}
        role="listbox"
        aria-label="Commit history"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="vlist__sizer" style={{ height: vs.totalHeight }} aria-hidden="true" />
        <div className="vlist__content" style={{ transform: `translateY(${-vs.top}px)` }}>
          {commits.slice(vs.start, vs.end).map((commit, i) => {
            const refs = parseRefs(commit.refs)
            const overflow = refs.length - MAX_LIST_REFS
            const active = selectedCommit?.hash === commit.hash
            return (
              <button
                key={commit.hash}
                className={`commit${active ? ' is-active' : ''}`}
                role="option"
                aria-selected={active}
                style={{ position: 'absolute', top: vs.rowTop(vs.start + i), left: 0, right: 0 }}
                onClick={() => {
                  vs.viewportEl?.focus()
                  onSelectCommit(commit)
                }}
                onContextMenu={
                  commitMenuFor
                    ? (e) => {
                        e.preventDefault()
                        onSelectCommit(commit)
                        setMenu({ x: e.clientX, y: e.clientY, items: commitMenuFor(commit) })
                      }
                    : undefined
                }
              >
                <AvatarStack
                  author={{ name: commit.authorName, email: commit.authorEmail }}
                  coAuthors={coAuthorsOf(commit)}
                  size={28}
                />
                <div className="commit__main">
                  <div className="commit__subject" data-tip={commit.subject} data-tip-overflow="">
                    {commit.subject}
                  </div>
                  {refs.length > 0 && (
                    <div className="commit__refs">
                      {refs.slice(0, MAX_LIST_REFS).map((ref) => (
                        <RefChip key={ref.name} refItem={ref} />
                      ))}
                      {overflow > 0 && <span className="ref-chip ref-chip--more">+{overflow}</span>}
                    </div>
                  )}
                  <div className="commit__meta">
                    <span className="commit__author">{commit.authorName}</span>
                    <span>· {commit.relativeDate}</span>
                  </div>
                </div>
              </button>
            )
          })}
          {hasMore && (
            <div
              className="commit-list__more"
              style={{ position: 'absolute', top: vs.rowTop(commits.length), left: 0, right: 0 }}
              aria-hidden="true"
            >
              {loadingMore && <div className="spinner spinner--sm" />}
            </div>
          )}
        </div>
        <VScrollbar vs={vs} />
      </div>

      {selectedCommit && (
        <>
          <Resizer
            orientation="y"
            invert
            size={filesHeight}
            min={140}
            max={640}
            onPreview={(h) => {
              if (filesRef.current) filesRef.current.style.height = `${h}px`
            }}
            onCommit={setFilesHeight}
          />
          <div className="commit-files" ref={filesRef} style={{ height: filesHeight }}>
            <div className="section-head commit-files__head">
              {commitFilesLoading
                ? filesSpin
                  ? 'Loading…'
                  : ' '
                : filterActive
                  ? `${visibleFiles.length} of ${commitFiles.length}`
                  : pluralize(commitFiles.length, 'file')}
            </div>
            {!commitFilesLoading && commitFiles.length > 0 && filterBar}
            <div className="tree-wrap">
              {commitFilesLoading ? (
                filesSpin && (
                  <div className="center-state">
                    <div className="spinner" />
                  </div>
                )
              ) : commitFiles.length === 0 ? (
                <div className="list-empty">No file changes in this commit.</div>
              ) : visibleFiles.length === 0 ? (
                <div className="list-empty">No files match the filter.</div>
              ) : (
                <WorkingFileList
                  key={selectedCommit.hash}
                  files={visibleFiles}
                  selectedPath={selectedFilePath}
                  // Read-only list: deselecting everything keeps the last diff.
                  onSelect={(path) => path !== null && onSelectFile(path)}
                  highlight={filterQuery}
                  onSelectionChange={onFileSelectionChange}
                  contextMenuFor={(selected) => copyPathItems(selected, repoPath)}
                />
              )}
            </div>
          </div>
        </>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
