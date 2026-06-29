// The checkbox commit model, renderer side. Checkboxes are pure renderer
// state — toggling never touches git. These pure helpers turn the per-path
// selection map into the payloads the main process applies in one atomic
// step at commit/stash time.

import type { ChangedFile, CommitSelection } from '@shared/types'

/**
 * What one contributing change block puts into the commit: its standalone patch,
 * plus the changed-line keys (see `lib/staging`) left *out* within it. An empty
 * `excluded` set means the whole block is in; a non-empty one means the patch
 * already covers just the kept lines. A block with everything excluded never
 * appears — it simply isn't in the map.
 */
export interface BlockSelection {
  patch: string
  excluded: ReadonlySet<string>
}

/** Per-file commit selection: 'all', 'none', or the contributing change blocks
 *  (block index → its `BlockSelection`). Missing key = 'all'. */
export type FileSelection = 'all' | 'none' | ReadonlyMap<number, BlockSelection>

export type SelectionMap = ReadonlyMap<string, FileSelection>

/**
 * Assemble the next commit from the checkboxes: fully included paths plus
 * standalone hunk patches for partially included files. `all` short-circuits
 * the path list so the main process can run a plain `git add -A`.
 * Conflicted files are never committed from here.
 */
export function buildCommitSelection(
  changes: readonly ChangedFile[],
  selections: SelectionMap
): Omit<CommitSelection, 'amend'> {
  const paths: string[] = []
  const patches: string[] = []
  let all = true
  for (const f of changes) {
    if (f.status === 'conflicted') {
      all = false
      continue
    }
    const sel = selections.get(f.path) ?? 'all'
    if (sel === 'all') {
      paths.push(f.path)
    } else {
      all = false
      if (sel !== 'none') for (const block of sel.values()) patches.push(block.patch)
    }
  }
  return { all, paths: all ? [] : paths, patches }
}

/**
 * The paths a stash of the checked files covers (stash granularity is the
 * file — partially included files are stashed whole). `all` means every
 * stashable file is checked, so `git stash push` can run with no pathspec.
 */
export function buildStashSelection(
  changes: readonly ChangedFile[],
  selections: SelectionMap
): { all: boolean; paths: string[] } {
  const paths: string[] = []
  let all = true
  for (const f of changes) {
    if (f.status === 'conflicted') {
      all = false
      continue
    }
    if ((selections.get(f.path) ?? 'all') === 'none') all = false
    else paths.push(f.path)
  }
  return { all, paths }
}
