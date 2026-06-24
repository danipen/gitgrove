// Cross-cutting helpers shared by the write/ domain modules: locale pinning,
// unborn-HEAD detection, the unmerged-index probe, and the auto-stash marker.
// Kept here so the domain files don't have to import one another.

import { runRead } from '../exec'

/** Locale-proof env for git invocations whose error/output text we inspect. */
export const ENGLISH = { LC_ALL: 'C' }

/** True when an error means HEAD doesn't resolve (unborn branch, no commits). */
export const isUnbornHead = (e: unknown) =>
  e instanceof Error &&
  /ambiguous argument 'HEAD'|unknown revision|Failed to resolve 'HEAD'/i.test(e.message)

/**
 * True when the index holds unmerged entries — the locale-independent way to
 * tell "stopped on conflicts" (normal workflow) from a genuine failure after
 * a merge/rebase/squash exits non-zero. Covers `merge --squash` too, which
 * conflicts without leaving a MERGE_HEAD behind.
 */
export async function hasUnmergedEntries(repoPath: string): Promise<boolean> {
  try {
    return (await runRead(repoPath, ['ls-files', '-u', '-z'])).length > 0
  } catch {
    return false
  }
}

/**
 * Marker GitGrove uses as the message of stashes it creates itself when the
 * user leaves changes behind while switching branches (the GitHub Desktop
 * trick). Git prefixes the stored subject with "On <branch>: ", so the entry
 * stays tied to its branch for free; parseStashList recognizes the marker and
 * the renderer shows a welcome-back reminder when that branch is current
 * again. Exported for tests.
 */
export const AUTO_STASH_MARKER = '!!GitGrove'
