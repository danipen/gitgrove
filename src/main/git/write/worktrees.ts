// Listing and managing worktrees.

import type { WorktreeInfo } from '@shared/types'
import { run, runRead } from '../exec'

/** Parse `git worktree list --porcelain`. Exported for tests. */
export function parseWorktrees(out: string, currentPath: string): WorktreeInfo[] {
  const blocks = out.split('\n\n').filter((b) => b.trim())
  return blocks.map((block, i) => {
    const lines = block.split('\n')
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length) ?? ''
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? ''
    const branchRef = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length)
    return {
      path,
      branch: branchRef ? branchRef.replace(/^refs\/heads\//, '') : null,
      headShort: head.slice(0, 7),
      isMain: i === 0,
      isCurrent: path === currentPath
    }
  })
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const out = await runRead(repoPath, ['worktree', 'list', '--porcelain'])
  return parseWorktrees(out, repoPath)
}

export async function addWorktree(
  repoPath: string,
  path: string,
  opts: { branch?: string; newBranch?: string } = {}
): Promise<void> {
  const args = ['worktree', 'add']
  if (opts.newBranch) args.push('-b', opts.newBranch)
  args.push(path)
  if (opts.branch) args.push(opts.branch)
  await run(repoPath, args)
}

export async function removeWorktree(
  repoPath: string,
  path: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const args = ['worktree', 'remove']
  if (opts.force) args.push('--force')
  args.push(path)
  await run(repoPath, args)
}
