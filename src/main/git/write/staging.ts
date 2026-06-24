// Staging-area operations: stage/unstage paths, stage/unstage all, and the
// patch-apply that drives hunk-level staging.

import { run } from '../exec'
import { isUnbornHead } from './internal'

export async function stageFiles(repoPath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  // -A so a deleted file stages as a deletion; `--` guards odd filenames.
  await run(repoPath, ['add', '-A', '--', ...paths])
}

export async function unstageFiles(repoPath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  // On a repo with no commits HEAD doesn't resolve, so unstaging means
  // removing the entry from the index entirely — but ONLY in that case; any
  // other failure must surface, never silently untrack files.
  try {
    await run(repoPath, ['reset', '-q', 'HEAD', '--', ...paths])
  } catch (e) {
    if (!isUnbornHead(e)) throw e
    await run(repoPath, ['rm', '--cached', '-r', '-q', '--', ...paths])
  }
}

export async function stageAll(repoPath: string): Promise<void> {
  await run(repoPath, ['add', '-A'])
}

export async function unstageAll(repoPath: string): Promise<void> {
  try {
    await run(repoPath, ['reset', '-q', 'HEAD', '--', '.'])
  } catch (e) {
    if (!isUnbornHead(e)) throw e
    await run(repoPath, ['rm', '--cached', '-r', '-q', '--', '.'])
  }
}

/**
 * Apply a patch to the index and/or working tree. Drives hunk-level staging:
 * the renderer slices the file patch into per-hunk patches and sends them here.
 *  - stage hunk:    cached, !reverse, !workingTree
 *  - unstage hunk:  cached, reverse, !workingTree
 *  - discard hunk:  !cached, reverse, workingTree
 */
export async function applyPatch(
  repoPath: string,
  patch: string,
  opts: { cached?: boolean; reverse?: boolean }
): Promise<void> {
  const args = ['apply', '--whitespace=nowarn']
  if (opts.cached) args.push('--cached')
  if (opts.reverse) args.push('--reverse')
  args.push('-')
  await run(repoPath, args, { input: patch.endsWith('\n') ? patch : `${patch}\n` })
}
