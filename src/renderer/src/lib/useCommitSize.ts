// On-disk size of the files included in the next commit — a fast, honest proxy
// for "how big is this commit". Debounced, and skipped on gigantic selections
// so the stat pass stays trivial. null = unknown (too many files, or in
// flight); 0 = nothing included.

import type { ChangedFile } from '@shared/types'
import { useEffect, useState } from 'react'
import type { FileSelection } from './commit-selection'

/** Above this many files we skip the stat pass entirely (size shows as unknown). */
const MAX_SIZED_FILES = 20000

export function useCommitSize(
  getRepoPath: () => string | undefined,
  changes: ChangedFile[],
  selections: Map<string, FileSelection>
): number | null {
  const [commitSize, setCommitSize] = useState<number | null>(null)

  useEffect(() => {
    const repoPath = getRepoPath()
    if (!repoPath) return
    const t = setTimeout(() => {
      const paths: string[] = []
      for (const f of changes) {
        if (f.status === 'conflicted' || f.status === 'deleted') continue
        if ((selections.get(f.path) ?? 'all') !== 'none') paths.push(f.path)
      }
      if (paths.length === 0 || paths.length > MAX_SIZED_FILES) {
        setCommitSize(paths.length === 0 ? 0 : null)
        return
      }
      window.gitgrove
        .selectionSize(repoPath, paths)
        .then(setCommitSize)
        .catch(() => setCommitSize(null))
    }, 400)
    return () => clearTimeout(t)
  }, [changes, selections, getRepoPath])

  return commitSize
}
