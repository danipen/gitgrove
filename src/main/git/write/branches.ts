// Branch operations and the leave/bring choreography that carries (or stashes)
// uncommitted changes across every branch switch.

import type { BranchChangesAction, CheckoutOutcome } from '@shared/types'
import { enqueue, type ProgressHandler, type RunOptions, run, runOnce } from '../exec'
import { openLfsProgressChannel } from '../lfs-progress'
import { AUTO_STASH_MARKER, ENGLISH, hasUnmergedEntries } from './internal'

/**
 * The leave/bring choreography shared by every branch switch — checking out
 * an existing branch and create-and-checkout. Runs `checkoutArgs` honouring
 * what the user chose for their uncommitted changes; MUST run inside the
 * write queue (callers hold it via `enqueue`).
 *
 *  - 'leave': stash everything (marker message, see AUTO_STASH_MARKER) on the
 *    current branch first, so the destination starts clean and the changes
 *    are waiting when the user comes back;
 *  - 'bring': checkout first — git carries the working tree for free whenever
 *    it can, preserving staged state exactly. Only when the destination
 *    diverges through a dirty file (git refuses: "would be overwritten") do
 *    the changes ferry across via a transient stash + pop. A pop that hits
 *    conflicts resolves as 'conflicts' data and keeps the stash as a safety
 *    net — git's own behaviour, never presented as an error.
 *
 * If the checkout itself fails after a stash was taken, the stash is popped
 * back so a failed switch never silently relocates the user's changes.
 */
async function checkoutWithChanges(
  repoPath: string,
  checkoutArgs: string[],
  changes: BranchChangesAction | undefined,
  checkoutOpts: RunOptions = {}
): Promise<CheckoutOutcome> {
  const restoreStash = () => runOnce(repoPath, ['stash', 'pop']).catch(() => {})
  if (changes === 'leave') {
    await runOnce(repoPath, ['stash', 'push', '-u', '-m', AUTO_STASH_MARKER])
    try {
      await runOnce(repoPath, checkoutArgs, checkoutOpts)
    } catch (e) {
      await restoreStash()
      throw e
    }
    return 'completed'
  }
  try {
    await runOnce(repoPath, checkoutArgs, {
      ...checkoutOpts,
      env: { ...checkoutOpts.env, ...ENGLISH }
    })
    return 'completed'
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (changes !== 'bring' || !/would be overwritten by checkout/i.test(message)) throw e
    // The destination diverges through dirty files — ferry them in a stash.
    await runOnce(repoPath, ['stash', 'push', '-u'])
    try {
      await runOnce(repoPath, checkoutArgs, checkoutOpts)
    } catch (checkoutError) {
      await restoreStash()
      throw checkoutError
    }
    try {
      await runOnce(repoPath, ['stash', 'pop'])
    } catch (popError) {
      // Conflicted pop: git applied what it could, marked the rest unmerged
      // and kept the stash. The user resolves in the normal conflict flow.
      if (await hasUnmergedEntries(repoPath)) return 'conflicts'
      throw popError
    }
    return 'completed'
  }
}

/**
 * Create a branch. With checkout (the default), uncommitted changes are
 * handled per `opts.changes` — see checkoutWithChanges — as one atomic step
 * on the write queue.
 */
export async function createBranch(
  repoPath: string,
  name: string,
  opts: { from?: string; checkout?: boolean; changes?: BranchChangesAction } = {}
): Promise<CheckoutOutcome> {
  const from = opts.from?.trim()
  if (opts.checkout === false) {
    await run(repoPath, from ? ['branch', name, from] : ['branch', name])
    return 'completed'
  }
  const checkoutArgs = from ? ['checkout', '-b', name, from] : ['checkout', '-b', name]
  return enqueue(repoPath, () => checkoutWithChanges(repoPath, checkoutArgs, opts.changes))
}

export async function deleteBranch(
  repoPath: string,
  name: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  await run(repoPath, ['branch', opts.force ? '-D' : '-d', name])
}

export async function renameBranch(repoPath: string, from: string, to: string): Promise<void> {
  await run(repoPath, ['branch', '-m', from, to])
}

/**
 * Switch branches, with uncommitted changes handled per `opts.changes` — see
 * checkoutWithChanges. Checkout rewrites HEAD, the index and the working
 * tree, so it MUST ride the write queue — running it concurrently with a
 * stage/commit is exactly the index.lock race the queue exists to prevent.
 * Progress comes from git's "Updating files: N%" stream (emitted only on
 * non-trivial switches).
 */
export async function checkoutBranch(
  repoPath: string,
  branch: string,
  opts: { changes?: BranchChangesAction } = {},
  onProgress?: ProgressHandler
): Promise<CheckoutOutcome> {
  const args = ['checkout', '--progress', branch]
  if (!onProgress) {
    return enqueue(repoPath, () => checkoutWithChanges(repoPath, args, opts.changes))
  }
  // Checking out can smudge LFS files (downloading missing objects), which
  // git's own progress doesn't cover — attach the LFS side channel so big
  // asset switches fill the progress bar instead of freezing it.
  const lfs = openLfsProgressChannel(onProgress)
  try {
    return await enqueue(repoPath, () =>
      checkoutWithChanges(repoPath, args, opts.changes, { onProgress, env: lfs.env })
    )
  } finally {
    await lfs.dispose()
  }
}

/** Check out a commit directly, leaving HEAD detached. */
export async function checkoutDetached(repoPath: string, hash: string): Promise<void> {
  await run(repoPath, ['checkout', '--detach', hash])
}
