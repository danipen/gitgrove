// Discarding changes: sort the chosen files into trash/reset/restore buckets
// (planDiscard) and carry that plan out as one atomic step on the write queue.

import type { DiscardItem } from '@shared/types'
import { enqueue, type ProgressHandler, runOnce } from '../exec'
import { isUnbornHead } from './internal'

/** Files restored per checkout-index spawn during a discard — small enough
 *  that each batch completes quickly (a progress report), large enough to
 *  stay a handful of spawns even on ten-thousand-file discards. */
const DISCARD_RESTORE_CHUNK = 1000

/** Where each discarded path goes: trashed, forgotten from the index, restored. */
export interface DiscardPlan {
  /** Paths HEAD doesn't have — moved to the OS trash so a mis-click is recoverable. */
  trashPaths: string[]
  /** Paths whose index entries are reset to HEAD (⊇ checkoutPaths). */
  resetPaths: string[]
  /** Paths restored from HEAD into the working tree. */
  checkoutPaths: string[]
}

/**
 * Sort the files of a discard into the three buckets `discardFiles` needs.
 * Discard means: every chosen path ends up exactly as in HEAD. Files HEAD
 * doesn't have — untracked, staged-new, rename targets — are trashed;
 * everything else is reset (unstaged) and restored from HEAD. A rename's R
 * entry lives in the index, so without the reset a discarded rename would
 * survive. Pure + exported for tests.
 */
export function planDiscard(files: DiscardItem[], untrackedPaths: string[]): DiscardPlan {
  const trashPaths = [...untrackedPaths]
  const resetPaths: string[] = []
  const checkoutPaths: string[] = []
  for (const f of files) {
    if (f.oldPath) {
      // Rename/copy: forget both sides, restore the old path, trash the new.
      trashPaths.push(f.path)
      resetPaths.push(f.path, f.oldPath)
      checkoutPaths.push(f.oldPath)
    } else if (f.status === 'added') {
      // Staged new file: nothing in HEAD to restore.
      trashPaths.push(f.path)
      resetPaths.push(f.path)
    } else {
      resetPaths.push(f.path)
      checkoutPaths.push(f.path)
    }
  }
  return { trashPaths, resetPaths, checkoutPaths }
}

/**
 * Throw away changes for tracked paths so they end up exactly as in HEAD,
 * as one atomic step on the write queue:
 *
 *   1. `git reset HEAD` the paths, so staged changes (including renames,
 *      whose R entry lives only in the index) are forgotten. A plain
 *      `checkout -- <path>` restores the worktree *from the index* and would
 *      leave staged state — exactly the bug where a discarded rename
 *      survives;
 *   2. `git checkout-index` the paths that exist in HEAD, writing the
 *      original files back to the worktree.
 *
 * `resetPaths` ⊇ `checkoutPaths`: rename targets and staged-new files are
 * reset but NOT checked out (they don't exist in HEAD — the caller moves
 * them to the OS trash, recoverable, instead). Pathspecs stream over stdin
 * NUL-separated, so a huge selection is two spawns with no argv limits.
 * Untracked files are *not* handled here — the caller trashes those too.
 */
export async function discardFiles(
  repoPath: string,
  resetPaths: string[],
  checkoutPaths: string[],
  onProgress?: ProgressHandler
): Promise<void> {
  if (resetPaths.length === 0 && checkoutPaths.length === 0) return
  await enqueue(repoPath, async () => {
    if (resetPaths.length > 0) {
      onProgress?.('Resetting index', 0)
      const input = resetPaths.join('\0')
      try {
        await runOnce(
          repoPath,
          ['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { input }
        )
      } catch (e) {
        // No commits yet: there is no HEAD to reset to — drop the index
        // entries instead (same unborn-branch handling as unstageFiles).
        if (!isUnbornHead(e)) throw e
        await runOnce(
          repoPath,
          ['rm', '--cached', '-r', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { input }
        )
      }
      onProgress?.('Resetting index', 100)
    }
    // -f overwrites modified worktree files, -u refreshes the index's stat
    // cache so the very next status doesn't re-examine these paths. Restored
    // in chunks so a huge discard reports determinate progress between spawns
    // (checkout-index itself is silent).
    for (let i = 0; i < checkoutPaths.length; i += DISCARD_RESTORE_CHUNK) {
      const chunk = checkoutPaths.slice(i, i + DISCARD_RESTORE_CHUNK)
      await runOnce(repoPath, ['checkout-index', '-f', '-u', '--stdin', '-z'], {
        input: chunk.join('\0')
      })
      onProgress?.(
        'Restoring files',
        Math.round(Math.min(100, ((i + chunk.length) / checkoutPaths.length) * 100))
      )
    }
  })
}
