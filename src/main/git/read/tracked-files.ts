// The repository's tracked files and where its index lives — the raw material
// of the command palette's file search (main/search/file-index.ts).

import { isAbsolute, join } from 'node:path'
import { runGit } from './core'

/**
 * Every tracked path, repo-relative and `/`-separated. `ls-files` reads the
 * index only — no working-tree walk — so it stays fast on huge repos. NUL-
 * delimited (`-z`) so any filename parses exactly. A conflicted path has one
 * index entry per stage; the sorted output lets consecutive repeats collapse.
 */
export async function listTrackedFiles(repoPath: string): Promise<string[]> {
  const out = await runGit(repoPath, ['ls-files', '-z'])
  const paths: string[] = []
  for (const path of out.split('\0')) {
    if (path && path !== paths[paths.length - 1]) paths.push(path)
  }
  return paths
}

/**
 * Absolute path of the repo's index file. Asked of git rather than assumed to
 * be `.git/index`: in a linked worktree `.git` is a file pointing elsewhere.
 */
export async function getIndexPath(repoPath: string): Promise<string> {
  const path = (await runGit(repoPath, ['rev-parse', '--git-path', 'index'])).trim()
  return isAbsolute(path) ? path : join(repoPath, path)
}
