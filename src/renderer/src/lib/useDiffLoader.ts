// Owns the diff pane's payload: loads working/commit diffs over IPC, de-races
// concurrent loads with a request token (a slow fetch can resolve after the
// user has already picked another file — only the newest request may write),
// and keeps the previous object when a refresh returns identical content so
// the memoized viewer doesn't re-render.

import type { ChangedFile, DiffPayload } from '@shared/types'
import { useCallback, useRef, useState } from 'react'

/**
 * Field-equality for diff payloads (string compares are cheap — native,
 * early-exit on length). Pure + exported for tests.
 */
export function samePayload(a: DiffPayload | null, b: DiffPayload): boolean {
  return (
    !!a &&
    a.path === b.path &&
    a.oldPath === b.oldPath &&
    a.status === b.status &&
    a.binary === b.binary &&
    a.notice === b.notice &&
    a.language === b.language &&
    a.patch === b.patch &&
    a.oldContents === b.oldContents &&
    a.newContents === b.newContents &&
    // Data URLs compare cheaply for the common case (same reference → same
    // string instance; different images differ early in the bytes).
    a.image?.old?.dataUrl === b.image?.old?.dataUrl &&
    a.image?.new?.dataUrl === b.image?.new?.dataUrl
  )
}

export function useDiffLoader(
  getRepoPath: () => string | undefined,
  onError: (e: unknown) => void
) {
  const [diff, setDiff] = useState<DiffPayload | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const req = useRef(0)
  // Mirror for re-select guards: read the showing diff without re-creating
  // the callbacks that consult it.
  const diffRef = useRef<DiffPayload | null>(diff)
  diffRef.current = diff

  const load = useCallback(
    async (fetchDiff: () => Promise<DiffPayload>) => {
      const id = ++req.current
      setDiffLoading(true)
      try {
        const payload = await fetchDiff()
        if (id === req.current) setDiff((prev) => (samePayload(prev, payload) ? prev : payload))
      } catch (e) {
        if (id === req.current) onError(e)
      } finally {
        if (id === req.current) setDiffLoading(false)
      }
    },
    [onError]
  )

  const loadWorkingDiff = useCallback(
    (file: ChangedFile) => {
      const repoPath = getRepoPath()
      if (repoPath) load(() => window.gitgrove.workingDiff(repoPath, file))
    },
    [getRepoPath, load]
  )

  const loadCommitDiff = useCallback(
    (hash: string, file: ChangedFile) => {
      const repoPath = getRepoPath()
      if (repoPath) load(() => window.gitgrove.commitDiff(repoPath, hash, file))
    },
    [getRepoPath, load]
  )

  /** A file's diff across `base..head` — the Graph tab's branch-changes view. */
  const loadRangeDiff = useCallback(
    (base: string | null, head: string, file: ChangedFile) => {
      const repoPath = getRepoPath()
      if (repoPath) load(() => window.gitgrove.rangeDiff(repoPath, base, head, file))
    },
    [getRepoPath, load]
  )

  /** Empty the pane and invalidate any in-flight load so it can't repopulate it. */
  const clearDiff = useCallback(() => {
    req.current++
    setDiff(null)
  }, [])

  return { diff, diffRef, diffLoading, loadWorkingDiff, loadCommitDiff, loadRangeDiff, clearDiff }
}
