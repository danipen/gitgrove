// Merge prediction and conflict inspection: preview what merging a branch
// would do (in memory, via merge-tree), read the three sides of a conflicted
// path for the resolution panel, and report the configured merge tool.

import type { ConflictSides, MergePreview } from '@shared/types'
import { MAX_CONTENTS_BYTES, readWorkingFile, runGit, showFile } from './core'

/**
 * Parse `git merge-tree --write-tree --name-only --no-messages HEAD <branch>`
 * output: the first line is the would-be tree oid, every following non-empty
 * line a path that would conflict (none on a clean merge). Pure + exported
 * for tests.
 */
export function parseMergeTreeNames(out: string): string[] {
  return out.split('\n').slice(1).filter(Boolean)
}

/**
 * Predict what merging `branch` into HEAD would do, without touching the
 * working tree or index. `merge-tree --write-tree` performs the real merge
 * in memory (writing only loose objects), so the prediction matches what
 * `git merge` will actually find. Requires git ≥ 2.38 — older gits report
 * `unknown` and the merge itself still works.
 */
export async function getMergePreview(repoPath: string, branch: string): Promise<MergePreview> {
  const countOut = await runGit(repoPath, ['rev-list', '--count', `HEAD..${branch}`])
  const commitCount = Number(countOut.trim()) || 0
  if (commitCount === 0) return { outcome: 'up-to-date', conflictedPaths: [], commitCount: 0 }
  try {
    // Exit 1 = "merged with conflicts" — expected, the names tell us which.
    const out = await runGit(
      repoPath,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branch],
      [1]
    )
    const conflictedPaths = parseMergeTreeNames(out)
    return {
      outcome: conflictedPaths.length > 0 ? 'conflicts' : 'clean',
      conflictedPaths,
      commitCount
    }
  } catch {
    return { outcome: 'unknown', conflictedPaths: [], commitCount }
  }
}

/** Number of `<<<<<<<` conflict regions in a working file. Pure + exported for tests. */
export function countConflictMarkers(contents: string): number {
  return contents.split('\n').filter((line) => line.startsWith('<<<<<<<')).length
}

/** Heuristic binary sniff, mirroring git's own: any NUL byte means binary. */
const looksBinary = (contents: string | null) => contents?.includes('\0') ?? false

/**
 * The three versions of a conflicted path for the conflict-resolution panel.
 * Index stage 1 is the common ancestor ("base"), stage 2 "ours" (HEAD),
 * stage 3 "theirs" (the branch being merged); a missing stage means the file
 * doesn't exist on that side (modify/delete, or added on both sides).
 */
export async function getConflictSides(repoPath: string, path: string): Promise<ConflictSides> {
  const [base, ours, theirs, working] = await Promise.all([
    showFile(repoPath, ':1', path),
    showFile(repoPath, ':2', path),
    showFile(repoPath, ':3', path),
    readWorkingFile(repoPath, path)
  ])
  const binary = looksBinary(base) || looksBinary(ours) || looksBinary(theirs)
  const size = (s: string | null) => Buffer.byteLength(s ?? '', 'utf8')
  // The panel renders one pair at a time, so cap each version on its own —
  // two small sides shouldn't lose their diff because the third is huge.
  const cap = (s: string | null) =>
    binary || s === null || size(s) > MAX_CONTENTS_BYTES ? null : s
  return {
    base: cap(base),
    ours: cap(ours),
    theirs: cap(theirs),
    // A missing stage means that side has no version of the file at all —
    // the panel must not mistake "too large to ship" for "deleted".
    oursDeleted: ours === null,
    theirsDeleted: theirs === null,
    markerCount: working === null || binary ? 0 : countConflictMarkers(working),
    binary
  }
}

/** The user's configured merge tool (`merge.tool`), or null when unset. */
export async function getMergeToolName(repoPath: string): Promise<string | null> {
  try {
    const out = (await runGit(repoPath, ['config', '--get', 'merge.tool'])).trim()
    return out || null
  } catch {
    return null
  }
}
