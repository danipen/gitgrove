// The commit selection: checkboxes are pure renderer state — every changed file
// defaults to included; toggling never touches git. Missing key = 'all'; 'none'
// = excluded; a Map = selected hunk indexes with their commit patches. This hook
// owns that state and the toggles that mutate it, plus the on-disk size of what
// the next commit would include. `setSelections` is returned so the lifecycle
// paths in App (repo switch, checkout, commit, stash) can reset it.

import type { ChangedFile } from '@shared/types'
import { type RefObject, useCallback, useState } from 'react'
import type { FileSelection } from '@/lib/commit-selection'
import { useCommitSize } from '@/lib/useCommitSize'

interface Params {
  // `changes` (reactive) feeds the size effect; `changesRef` (live value) is
  // read by the master checkbox without re-creating the callback on every edit.
  changes: ChangedFile[]
  changesRef: RefObject<ChangedFile[]>
  getRepoPath: () => string | undefined
  runOpRef: RefObject<(fn: () => Promise<unknown>) => Promise<boolean>>
}

export function useCommitSelections({ changes, changesRef, getRepoPath, runOpRef }: Params) {
  const [selections, setSelections] = useState<Map<string, FileSelection>>(new Map())

  /** Toggle a file's checkbox: indeterminate/unchecked → included, checked → excluded. */
  const toggleFileIncluded = useCallback((path: string) => {
    setSelections((prev) => {
      const next = new Map(prev)
      const cur = prev.get(path) ?? 'all'
      if (cur === 'all') next.set(path, 'none')
      else next.delete(path) // 'none' or partial → fully included
      return next
    })
  }, [])

  /** Master checkbox: include/exclude every file, or just `paths` when filtering. */
  const setAllIncluded = useCallback(
    (included: boolean, paths?: string[]) => {
      if (!paths) {
        setSelections(
          included
            ? new Map()
            : new Map(changesRef.current.map((f) => [f.path, 'none' as FileSelection]))
        )
        return
      }
      setSelections((prev) => {
        const next = new Map(prev)
        for (const p of paths) {
          if (included) next.delete(p)
          else next.set(p, 'none')
        }
        return next
      })
    },
    [changesRef]
  )

  /** Replace one file's hunk selection (from the diff's checkbox bars). */
  const setHunkSelection = useCallback(
    (path: string, selected: Map<number, string>, totalHunks: number) => {
      setSelections((prev) => {
        const next = new Map(prev)
        if (selected.size === totalHunks) next.delete(path)
        else if (selected.size === 0) next.set(path, 'none')
        else next.set(path, selected)
        return next
      })
    },
    []
  )

  /** Discard a hunk in the working tree (reverse-apply its display patch). */
  const discardHunk = useCallback(
    (patch: string) => {
      const repoPath = getRepoPath()
      if (!repoPath) return
      runOpRef.current(() => window.gitgrove.applyPatch(repoPath, patch, { reverse: true }))
    },
    [getRepoPath, runOpRef]
  )

  // On-disk size of the files included in the next commit — see useCommitSize.
  const commitSize = useCommitSize(getRepoPath, changes, selections)

  return {
    selections,
    setSelections,
    toggleFileIncluded,
    setAllIncluded,
    setHunkSelection,
    discardHunk,
    commitSize
  }
}
