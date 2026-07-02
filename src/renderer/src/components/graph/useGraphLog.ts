// The Graph tab's data feed: fetches the all-branches log lazily (first visit),
// refreshes it while the tab is visible and marks it stale otherwise — the same
// contract useCommitLog follows for the History list. Date range and depth are
// part of the fetch key, so changing a filter or asking for more history simply
// reloads with the new window.

import type { Commit } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'

/** Default depth; "Show more" doubles it. Mirrors main's GRAPH_LOG_LIMIT. */
export const GRAPH_DEPTH = 2000

interface Params {
  repoPath: string
  /** True while the Graph tab is visible — the only time we actually fetch. */
  active: boolean
  /** Bumped by App on every repo refresh (watcher, post-op). */
  refreshNonce: number
  /** `git log --since` expression from the date filter, or null for all time. */
  since: string | null
  fail: (e: unknown) => void
}

export function useGraphLog({ repoPath, active, refreshNonce, since, fail }: Params) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [limit, setLimit] = useState(GRAPH_DEPTH)

  // What the current `commits` were loaded with; a mismatch means stale.
  const loadedKeyRef = useRef<string | null>(null)
  // Supersession token: a slow fetch for a previous repo/filter must not land.
  const reqRef = useRef(0)

  const key = `${repoPath}|${since ?? ''}|${limit}|${refreshNonce}`

  // A repo switch invalidates everything, including the depth the user grew.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the repo switch is the intentional trigger
  useEffect(() => {
    reqRef.current++
    loadedKeyRef.current = null
    setCommits([])
    setLoaded(false)
    setLoading(false)
    setLimit(GRAPH_DEPTH)
  }, [repoPath])

  useEffect(() => {
    if (!active || loadedKeyRef.current === key) return
    const id = ++reqRef.current
    setLoading(true)
    window.gitgrove
      .graphLog(repoPath, { limit, since: since ?? undefined })
      .then((result) => {
        if (id !== reqRef.current) return
        loadedKeyRef.current = key
        setCommits(result)
        setLoaded(true)
      })
      .catch((e) => {
        if (id === reqRef.current) fail(e)
      })
      .finally(() => {
        if (id === reqRef.current) setLoading(false)
      })
  }, [active, key, repoPath, limit, since, fail])

  /** Double the window — the "Show more history" affordance. */
  const showMore = useCallback(() => setLimit((l) => l * 2), [])

  return {
    commits,
    loading,
    loaded,
    /** True when the fetch filled the whole window — older history exists. */
    limitHit: commits.length >= limit,
    showMore
  }
}
