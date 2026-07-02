// The Graph tab's branch-changes selection: clicking a branch label opens the
// whole branch's diff — every file changed between the commit it grew from
// (base) and its tip. Mirrors useCommitDetail's contract: supersession token
// against slow fetches, re-select guards, first file auto-selected.

import type { ChangedFile } from '@shared/types'
import { useCallback, useRef, useState } from 'react'

/** What the branch-changes view compares: a branch's base → its tip. */
export interface BranchRange {
  /** Branch display name, for the pane header. */
  name: string
  /** Commit the branch grew from; null when it starts at a root commit. */
  base: string | null
  head: string
}

interface Params {
  getRepoPath: () => string | undefined
  fail: (e: unknown) => void
  loadRangeDiff: (base: string | null, head: string, file: ChangedFile) => void
  clearDiff: () => void
}

export function useBranchRange({ getRepoPath, fail, loadRangeDiff, clearDiff }: Params) {
  const [range, setRange] = useState<BranchRange | null>(null)
  const [rangeFiles, setRangeFiles] = useState<ChangedFile[]>([])
  const [rangeFilesLoading, setRangeFilesLoading] = useState(false)
  const [rangeSelPath, setRangeSelPath] = useState<string | null>(null)

  const req = useRef(0)
  const rangeRef = useRef<BranchRange | null>(range)
  rangeRef.current = range
  const filesRef = useRef<ChangedFile[]>(rangeFiles)
  filesRef.current = rangeFiles

  const selectRangeFile = useCallback(
    (path: string, opts?: { force?: boolean }) => {
      const r = rangeRef.current
      const file = filesRef.current.find((f) => f.path === path)
      if (!r || !file) return
      // Range diffs are immutable for a given base/head — re-clicking the
      // focused file would only flash the pane. `force` re-points after a
      // tab switch, when the pane may hold another view's diff for the path.
      if (!opts?.force && path === rangeSelPath) return
      setRangeSelPath(path)
      loadRangeDiff(r.base, r.head, file)
    },
    [rangeSelPath, loadRangeDiff]
  )

  /** Open the branch-changes view for `next` (or close it with null). */
  const openRange = useCallback(
    async (next: BranchRange | null) => {
      const repoPath = getRepoPath()
      const id = ++req.current
      setRange(next)
      setRangeFiles([])
      setRangeSelPath(null)
      if (!next || !repoPath) return
      setRangeFilesLoading(true)
      try {
        const files = await window.gitgrove.rangeFiles(repoPath, next.base, next.head)
        if (id !== req.current) return
        setRangeFiles(files)
        if (files.length > 0) {
          setRangeSelPath(files[0].path)
          loadRangeDiff(next.base, next.head, files[0])
        } else {
          clearDiff()
        }
      } catch (e) {
        if (id === req.current) fail(e)
      } finally {
        if (id === req.current) setRangeFilesLoading(false)
      }
    },
    [getRepoPath, fail, loadRangeDiff, clearDiff]
  )

  /** Drop the range selection (a commit was picked, repo switched, …). */
  const resetRange = useCallback(() => {
    req.current++
    setRange(null)
    setRangeFiles([])
    setRangeSelPath(null)
    setRangeFilesLoading(false)
  }, [])

  return {
    range,
    rangeFiles,
    rangeFilesLoading,
    rangeSelPath,
    openRange,
    selectRangeFile,
    resetRange
  }
}
