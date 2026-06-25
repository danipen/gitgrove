// The selected History commit and its file list: the async "commit → its
// changed files" fetch (guarded by a supersession token so a slow load can't
// overwrite a newer selection), plus the re-select guards that keep clicking
// the focused commit/file from reloading an identical, immutable diff.

import type { ChangedFile, Commit, DiffPayload } from '@shared/types'
import { type RefObject, useCallback, useRef, useState } from 'react'

interface Params {
  getRepoPath: () => string | undefined
  fail: (e: unknown) => void
  loadCommitDiff: (hash: string, file: ChangedFile) => void
  diffRef: RefObject<DiffPayload | null>
  clearDiff: () => void
}

export function useCommitDetail({ getRepoPath, fail, loadCommitDiff, diffRef, clearDiff }: Params) {
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null)
  const [commitFiles, setCommitFiles] = useState<ChangedFile[]>([])
  const [commitFilesLoading, setCommitFilesLoading] = useState(false)
  const [commitSelPath, setCommitSelPath] = useState<string | null>(null)
  const [commitSelCount, setCommitSelCount] = useState(1)

  // Commit-selection request token: selecting a commit fires an async
  // `commitFiles` fetch, and a slow one can resolve after the user has already
  // picked another commit. This token lets a superseded selection bail out.
  const commitReq = useRef(0)
  // Ref for the re-select guard: clicking the already-focused file must be a
  // no-op instead of refetching (and flashing) an identical diff.
  const commitSelPathRef = useRef<string | null>(commitSelPath)
  commitSelPathRef.current = commitSelPath
  const selectedCommitRef = useRef<Commit | null>(selectedCommit)
  selectedCommitRef.current = selectedCommit
  // Hash whose file list is loaded (or loading); null after a failed fetch so
  // re-clicking the commit retries.
  const commitFilesHashRef = useRef<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: diffRef is read for its live value, not as a trigger — depending on it would churn this handler on every diff load.
  const selectCommitFile = useCallback(
    (path: string, hash: string, list?: ChangedFile[], opts?: { force?: boolean }) => {
      const file = (list ?? commitFiles).find((f) => f.path === path)
      if (!file) return
      // Commit diffs are immutable — re-clicking the focused file would only
      // reload the identical payload and flash the pane. `force` bypasses this
      // for tab switches (the pane may hold a working diff for the same path)
      // and for cross-commit auto-selects of the same path.
      if (!opts?.force && path === commitSelPathRef.current && diffRef.current?.path === path) {
        return
      }
      setCommitSelPath(path)
      loadCommitDiff(hash, file)
    },
    [commitFiles, loadCommitDiff]
  )

  const selectCommit = useCallback(
    async (commit: Commit) => {
      const repoPath = getRepoPath()
      if (!repoPath) return
      // Re-selecting the selected commit (click or right-click) is a no-op —
      // its file list and diff are immutable and already loaded (or loading).
      // Still adopt the new object: a refreshed log may carry updated refs.
      if (
        commit.hash === selectedCommitRef.current?.hash &&
        commitFilesHashRef.current === commit.hash
      ) {
        setSelectedCommit(commit)
        return
      }
      const id = ++commitReq.current
      commitFilesHashRef.current = commit.hash
      setSelectedCommit(commit)
      setCommitSelPath(null)
      setCommitFiles([])
      setCommitFilesLoading(true)
      try {
        const files = await window.gitgrove.commitFiles(repoPath, commit.hash)
        // A newer commit was selected while this one was loading — drop the
        // stale result so it can't overwrite the current commit's state.
        if (id !== commitReq.current) return
        setCommitFiles(files)
        // Force: the previous commit may have focused the same path, whose
        // (different) diff must not be kept.
        if (files.length > 0) selectCommitFile(files[0].path, commit.hash, files, { force: true })
        else clearDiff()
      } catch (e) {
        if (id === commitReq.current) {
          commitFilesHashRef.current = null
          fail(e)
        }
      } finally {
        if (id === commitReq.current) setCommitFilesLoading(false)
      }
    },
    [getRepoPath, fail, selectCommitFile, clearDiff]
  )

  /** Clear the selected commit and its files (branch switch / repo open). */
  const resetDetail = useCallback(() => {
    // Bump the token (and forget the loaded hash) so a commit-files fetch still
    // in flight for the previous repo can't repopulate the cleared selection or
    // fire a stale commit diff into the pane — mirrors clearDiff / resetLog. The
    // bailed fetch's token-guarded `finally` won't clear its spinner, so do it here.
    commitReq.current++
    commitFilesHashRef.current = null
    setSelectedCommit(null)
    setCommitFiles([])
    setCommitSelPath(null)
    setCommitFilesLoading(false)
  }, [])

  return {
    selectedCommit,
    commitFiles,
    commitFilesLoading,
    commitSelPath,
    commitSelCount,
    setCommitSelCount,
    selectCommit,
    selectCommitFile,
    resetDetail
  }
}
