// The History tab's commit log: the paged fetch, infinite-scroll paging with
// its re-entrancy guard and stale-page token, and the debounced server-side
// (`git log --grep`) filter. Self-contained complexity — the orchestrators
// (refresh, branch switch, reveal-a-commit) just call loadLog / resetLog /
// markLogStale; all the racing-and-guarding lives here.

import type { Commit } from '@shared/types'
import { useCallback, useRef, useState } from 'react'

const LOG_LIMIT = 300

export function useCommitLog(getRepoPath: () => string | undefined, fail: (e: unknown) => void) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [commitsLoading, setCommitsLoading] = useState(false)
  // Infinite scroll: whether older commits may exist past what's loaded, and
  // whether a "load more" page is currently in flight (bottom spinner).
  const [logHasMore, setLogHasMore] = useState(false)
  const [commitsLoadingMore, setCommitsLoadingMore] = useState(false)
  const [logLoaded, setLogLoaded] = useState(false)
  // Free-text History filter. Applied server-side (`git log --grep`) so it
  // searches the whole history, not just the loaded page; a short debounce keeps
  // typing from re-running the log on every keystroke.
  const [logSearch, setLogSearch] = useState('')
  // True from the keystroke until the grep's results land (covers the debounce
  // too) so the filter bar can show a spinner — the grep is slow on big repos.
  const [logSearching, setLogSearching] = useState(false)
  // Hash being revealed from the blame gutter when it sits past the loaded
  // window: paging the log deep enough to reach a super-old commit can take a
  // moment, so HistoryView shows a blocking overlay for it. Null otherwise.
  const [revealingCommit, setRevealingCommit] = useState<string | null>(null)

  const logLoadedRef = useRef(logLoaded)
  logLoadedRef.current = logLoaded
  // Mirrors for the pager: read the latest list/`hasMore` without re-creating
  // `loadMoreLog` (its identity stays stable across appends).
  const commitsRef = useRef<Commit[]>(commits)
  commitsRef.current = commits
  const logHasMoreRef = useRef(logHasMore)
  logHasMoreRef.current = logHasMore
  // Re-entrancy guard for the pager + a token so a full log reload (branch
  // switch, refresh) invalidates any in-flight "load more" page: appending a
  // stale page from another branch would corrupt the list.
  const loadingMoreRef = useRef(false)
  const logReq = useRef(0)
  // Current History filter, read by loadLog/loadMoreLog so every refresh and
  // paged fetch honours it without depending on the search's identity.
  const logSearchRef = useRef(logSearch)
  logSearchRef.current = logSearch
  // Debounce handle for the search-triggered reload (cleared on a fresh keystroke
  // and when a commit is revealed, which clears the filter outright).
  const logSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadLog = useCallback(
    async (repoPath: string, ref?: string, opts?: { keepCount?: boolean; minCount?: number }) => {
      // `keepCount` (watcher/post-op refresh): re-fetch everything the user has
      // already paged in, so the list never shrinks back to the first page and
      // yanks their scroll position. `minCount` (reveal-a-commit): page deep
      // enough to include a specific commit. Fresh loads reset to one page.
      const limit = Math.max(
        LOG_LIMIT,
        opts?.keepCount ? commitsRef.current.length : 0,
        opts?.minCount ?? 0
      )
      const id = ++logReq.current
      setCommitsLoading(true)
      try {
        const log = await window.gitgrove.log(repoPath, {
          limit,
          ref,
          search: logSearchRef.current
        })
        if (id === logReq.current) {
          setCommits(log)
          // A short page means we hit the root commit — nothing left to page in.
          setLogHasMore(log.length >= limit)
          setLogLoaded(true)
        }
        return log
      } finally {
        if (id === logReq.current) {
          setCommitsLoading(false)
          // The freshest load has landed — drop the filter spinner (any load
          // settles it; only a search keystroke ever raises it).
          setLogSearching(false)
        }
      }
    },
    []
  )

  /** Appends the next page of history when the list scrolls near the bottom. */
  const loadMoreLog = useCallback(async () => {
    const repoPath = getRepoPath()
    if (!repoPath || loadingMoreRef.current || !logHasMoreRef.current) return
    loadingMoreRef.current = true
    const id = logReq.current
    setCommitsLoadingMore(true)
    try {
      const page = await window.gitgrove.log(repoPath, {
        limit: LOG_LIMIT,
        skip: commitsRef.current.length,
        search: logSearchRef.current
      })
      // A reload (branch switch / refresh) raced us: drop this stale page.
      if (id !== logReq.current) return
      setLogHasMore(page.length >= LOG_LIMIT)
      if (page.length > 0) {
        setCommits((prev) => {
          // `--skip` is offset-based, so a commit landing upstream mid-scroll
          // shifts the window and can hand us rows we already have — dedupe to
          // keep React keys (and the list) clean.
          const seen = new Set(prev.map((c) => c.hash))
          const fresh = page.filter((c) => !seen.has(c.hash))
          return fresh.length > 0 ? [...prev, ...fresh] : prev
        })
      }
    } catch (e) {
      fail(e)
    } finally {
      loadingMoreRef.current = false
      setCommitsLoadingMore(false)
    }
  }, [getRepoPath, fail])

  /**
   * Drive the History filter: keep the input responsive (state updates at once)
   * while debouncing the `git log --grep` reload that re-fetches the first page
   * for the new query. `logSearchRef` is set synchronously so the reload — and
   * any refresh racing it — reads the latest term.
   */
  const onLogSearchChange = useCallback(
    (query: string) => {
      setLogSearch(query)
      logSearchRef.current = query
      // Feedback starts now (through the debounce + grep), cleared when loadLog
      // settles. Stays false for an unchanged query so clearing it is silent.
      setLogSearching(true)
      if (logSearchTimer.current) clearTimeout(logSearchTimer.current)
      logSearchTimer.current = setTimeout(() => {
        logSearchTimer.current = null
        const repoPath = getRepoPath()
        if (repoPath) loadLog(repoPath).catch(fail)
      }, 200)
    },
    [getRepoPath, loadLog, fail]
  )

  /** Clear the filter and any pending debounced reload (reveal-a-commit, repo open). */
  const clearLogSearch = useCallback(() => {
    if (logSearchTimer.current) {
      clearTimeout(logSearchTimer.current)
      logSearchTimer.current = null
    }
    setLogSearch('')
    logSearchRef.current = ''
  }, [])

  /** Mark the loaded log stale so the next History visit refetches it. */
  const markLogStale = useCallback(() => setLogLoaded(false), [])

  /** Drop the loaded log entirely (branch switch / repo open); keeps the filter. */
  const resetLog = useCallback(() => {
    // Bump the token so a loadLog/loadMoreLog still in flight for the previous
    // repo or branch bails instead of landing its commits (and `logLoaded`) in
    // the now-reset list — the same invalidation clearDiff does for the pane.
    // Its `finally` is token-guarded and so won't clear the loading flags it
    // raised; clear them here, or the spinner sticks and (since the next visit
    // gates loadLog on `!commitsLoading`) the new repo's log never loads.
    logReq.current++
    loadingMoreRef.current = false
    setCommits([])
    setLogHasMore(false)
    setLogLoaded(false)
    setCommitsLoading(false)
    setCommitsLoadingMore(false)
    setLogSearching(false)
  }, [])

  return {
    commits,
    commitsLoading,
    logHasMore,
    commitsLoadingMore,
    logLoaded,
    logSearch,
    logSearching,
    revealingCommit,
    logLoadedRef,
    commitsRef,
    logSearchRef,
    loadLog,
    loadMoreLog,
    onLogSearchChange,
    clearLogSearch,
    markLogStale,
    resetLog,
    setRevealingCommit
  }
}
