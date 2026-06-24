// Resolving merge/rebase conflicts: take one side wholesale, mark a path
// resolved, or hand off to the user's configured merge tool.

import { run, runOnce } from '../exec'

/**
 * Resolve a conflicted path by taking one side wholesale, then stage it.
 * In a modify/delete conflict the chosen side may not have the file at all
 * (`checkout --ours/--theirs` fails with "does not have our/their version") —
 * taking that side then means resolving as deleted.
 */
export async function resolveConflict(
  repoPath: string,
  path: string,
  side: 'ours' | 'theirs'
): Promise<void> {
  try {
    await run(repoPath, ['checkout', side === 'ours' ? '--ours' : '--theirs', '--', path])
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!/does not have (our|their) version/i.test(message)) throw e
    await run(repoPath, ['rm', '-f', '-q', '--', path])
    return
  }
  await run(repoPath, ['add', '--', path])
}

/** Mark a conflicted path resolved as currently saved on disk. */
export async function markResolved(repoPath: string, path: string): Promise<void> {
  await run(repoPath, ['add', '--', path])
}

/**
 * Launch the user's configured merge tool for one conflicted path. Deliberately
 * NOT on the write queue: mergetool blocks until the external tool closes,
 * which would freeze every other git operation behind it. The tool writes the
 * file; the watcher-driven refresh picks up the result.
 */
export async function openMergeTool(repoPath: string, path: string): Promise<void> {
  await runOnce(repoPath, ['mergetool', '--no-prompt', '--', path])
}
