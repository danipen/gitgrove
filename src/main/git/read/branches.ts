// Branch enumeration: the local/remote branch lists, the checked-out and
// default branches, the recently checked-out set (mined from the reflog), and
// the cheap quick-summary returned synchronously on repo open.

import { basename } from 'node:path'
import type { BranchInfo, RepoSummary } from '@shared/types'
import { runGit } from './core'

/**
 * Resolve what HEAD points at. `symbolic-ref` answers with the branch name on
 * a normal (or unborn) branch and exits 1 when detached; detached HEAD then
 * resolves to its short hash.
 */
async function resolveHead(repoPath: string): Promise<{ current: string; detached: boolean }> {
  try {
    const name = (await runGit(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD'], [1])).trim()
    if (name) return { current: name, detached: false }
  } catch {
    /* fall through to detached handling */
  }
  try {
    const short = (await runGit(repoPath, ['rev-parse', '--short', 'HEAD'])).trim()
    return { current: short, detached: true }
  } catch {
    return { current: 'HEAD', detached: true }
  }
}

/** How many recently checked-out branches the switcher's RECENT section shows. */
const RECENT_BRANCH_LIMIT = 5

/**
 * Extract recently checked-out branches from reflog subjects (`%gs` lines like
 * "checkout: moving from feature/x to main"): the checkout *targets*, newest
 * first, deduplicated, kept only when still in `candidates` (so deleted
 * branches and detached-HEAD hashes drop out). Pure + exported for tests.
 */
export function parseRecentBranches(
  reflog: string,
  candidates: ReadonlySet<string>,
  limit = RECENT_BRANCH_LIMIT
): string[] {
  const recent: string[] = []
  for (const line of reflog.split('\n')) {
    // Refnames can never contain spaces, so the trailing token is exact.
    const target = line.match(/^checkout: moving from \S+ to (\S+)$/)?.[1]
    if (!target || !candidates.has(target) || recent.includes(target)) continue
    recent.push(target)
    if (recent.length >= limit) break
  }
  return recent
}

/**
 * The repo's default branch: what origin/HEAD points at, falling back to a
 * local/remote main or master. Null when nothing matches (e.g. a fresh repo
 * with a custom unborn branch).
 */
async function getDefaultBranch(
  repoPath: string,
  local: string[],
  remote: string[]
): Promise<string | null> {
  try {
    const ref = (
      await runGit(repoPath, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], [1])
    ).trim()
    if (ref) return ref.replace(/^origin\//, '')
  } catch {
    /* origin/HEAD not set locally — fall through to the name probe */
  }
  return (
    ['main', 'master'].find((name) => local.includes(name) || remote.includes(`origin/${name}`)) ??
    null
  )
}

export async function getBranches(repoPath: string): Promise<BranchInfo> {
  // One `for-each-ref` enumerates local + remote branches AND marks the
  // checked-out one (`*`). `git branch -v` (what a wrapper library would
  // run) additionally computes ahead/behind for every tracked branch, a rev
  // walk per branch that costs seconds on remote-heavy repos. Fields are
  // NUL-separated; refnames cannot contain NUL or newline, so line-based
  // parsing is exact. `--sort=-committerdate` puts freshly committed branches
  // first — the ordering the switcher wants — at no extra cost.
  const out = await runGit(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(HEAD)%00%(refname)%00%(refname:short)%00%(symref)',
    'refs/heads',
    'refs/remotes'
  ])
  const local: string[] = []
  const remote: string[] = []
  let current = ''
  for (const line of out.split('\n')) {
    if (!line) continue
    const [head, refname, short, symref] = line.split('\0')
    if (symref) continue // e.g. refs/remotes/origin/HEAD — a pointer, not a branch
    if (refname.startsWith('refs/heads/')) {
      local.push(short)
      if (head === '*') current = short
    } else if (refname.startsWith('refs/remotes/')) {
      remote.push(short)
    }
  }
  // No starred local ref: HEAD is unborn (first commit pending) or detached.
  const head = current ? { current, detached: false } : await resolveHead(repoPath)
  const defaultBranch = await getDefaultBranch(repoPath, local, remote)
  const recent = await getRecentBranches(repoPath, local, head.current, defaultBranch)
  return { ...head, local, remote, defaultBranch, recent }
}

/** Recently checked-out local branches, excluding current/default (shown elsewhere). */
async function getRecentBranches(
  repoPath: string,
  local: string[],
  current: string,
  defaultBranch: string | null
): Promise<string[]> {
  // The HEAD reflog records every checkout; 400 entries is weeks of work on an
  // active repo and still a single cheap local read.
  const reflog = await runGit(repoPath, ['reflog', '--format=%gs', '-n', '400']).catch(() => '')
  const candidates = new Set(local)
  candidates.delete(current)
  if (defaultBranch) candidates.delete(defaultBranch)
  return parseRecentBranches(reflog, candidates)
}

/**
 * A repo summary cheap enough to return synchronously on open: just the current
 * branch (one git call), no branch enumeration and no working-tree status. The
 * renderer uses this to switch repos instantly, then fetches the full branch
 * list and status in the background. Counts are left at zero — they aren't
 * surfaced in the UI.
 */
export async function getQuickSummary(repoPath: string): Promise<RepoSummary> {
  const { current, detached } = await resolveHead(repoPath)
  return {
    path: repoPath,
    name: basename(repoPath),
    branch: { current, detached, local: [], remote: [], defaultBranch: null, recent: [] },
    changeCount: 0,
    ahead: 0,
    behind: 0
  }
}
