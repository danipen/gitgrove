// Squash-merge candidates: which branch tips COULD have landed on the default
// branch by content (a squash or rebase merge) rather than by ancestry — the
// question main/git/read/squash-landings.ts answers with patch-ids. Pure and
// window-scoped: everything is derived from the loaded commits, so the main
// process never spawns git per branch. useSquashLandings feeds the answer to
// the layout, which then draws those branches as merged (a dashed merge
// connector into the landing commit — see layout.ts).

import type { Commit, SquashCandidate } from '@shared/types'
import { parseRefs } from '@/lib/format'

export interface SquashQuery {
  /** The default branch's first-parent chain in the window, newest first. */
  mainline: string[]
  /** Branch tips off the default branch, each with its merge base there. */
  candidates: SquashCandidate[]
}

/**
 * The default branch's newest tip in the window — local or remote, whichever
 * is newer: the pull-request host squashes on the remote, so `origin/main`
 * is often ahead of a local `main` that hasn't pulled yet.
 */
function mainlineTip(
  commits: readonly Commit[],
  remotes: readonly string[],
  defaultBranch: string
): Commit | undefined {
  const names = new Set([defaultBranch, ...remotes.map((r) => `${r}/${defaultBranch}`)])
  return commits.find((c) => parseRefs(c.refs).some((ref) => !ref.isTag && names.has(ref.name)))
}

/** Every commit reachable from `tip` within the window. */
function ancestorsOf(tip: Commit, commitByHash: ReadonlyMap<string, Commit>): Set<string> {
  const seen = new Set<string>([tip.hash])
  const stack = [tip]
  for (let c = stack.pop(); c; c = stack.pop()) {
    for (const parent of c.parents) {
      const next = commitByHash.get(parent)
      if (next && !seen.has(parent)) {
        seen.add(parent)
        stack.push(next)
      }
    }
  }
  return seen
}

/**
 * The tip's merge base with the mainline: walk its ancestry until it meets
 * commits the mainline already has, and take the newest meeting point (the
 * window is date-ordered, so the lowest index). Null when the walk leaves the
 * window first — the base is older than what's loaded, nothing to compare.
 */
function mergeBaseOf(
  tip: Commit,
  onMainline: ReadonlySet<string>,
  commitByHash: ReadonlyMap<string, Commit>,
  orderOf: ReadonlyMap<string, number>
): string | null {
  let best: string | null = null
  const seen = new Set<string>([tip.hash])
  const stack = [tip]
  for (let c = stack.pop(); c; c = stack.pop()) {
    for (const parent of c.parents) {
      if (seen.has(parent)) continue
      seen.add(parent)
      if (onMainline.has(parent)) {
        if (best === null || (orderOf.get(parent) ?? 0) < (orderOf.get(best) ?? 0)) best = parent
        continue
      }
      const next = commitByHash.get(parent)
      if (next) stack.push(next)
    }
  }
  return best
}

/**
 * The squash-landing question for this window, or null when there is nothing
 * to ask (no default branch in view, or every branch is already merged by
 * ancestry). Tag-only and HEAD-only commits aren't branches and never ask.
 */
export function squashQuery(
  commits: readonly Commit[],
  remotes: readonly string[],
  defaultBranch: string | null
): SquashQuery | null {
  if (!defaultBranch) return null
  const tip = mainlineTip(commits, remotes, defaultBranch)
  if (!tip) return null
  const commitByHash = new Map(commits.map((c) => [c.hash, c]))
  const orderOf = new Map(commits.map((c, i) => [c.hash, i]))
  const onMainline = ancestorsOf(tip, commitByHash)

  const mainline: string[] = []
  for (let c: Commit | undefined = tip; c; c = commitByHash.get(c.parents[0] ?? '')) {
    mainline.push(c.hash)
  }

  const candidates: SquashCandidate[] = []
  for (const commit of commits) {
    if (onMainline.has(commit.hash)) continue
    if (!parseRefs(commit.refs).some((ref) => !ref.isTag && ref.name !== 'HEAD')) continue
    const base = mergeBaseOf(commit, onMainline, commitByHash, orderOf)
    if (base) candidates.push({ tip: commit.hash, base })
  }
  return candidates.length > 0 ? { mainline, candidates } : null
}
