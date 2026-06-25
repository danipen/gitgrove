// Grouping + importance-ordering for a branch's pull requests. A head branch can
// carry several PRs (e.g. the same fix opened against `main` and a release
// branch), so the badge shows the most important one and a `+N` overflow. Kept
// pure (no React) so the ordering is unit-tested directly.

import type { PullRequestInfo } from '@shared/types'

/**
 * A branch's PRs as the UI holds them: the fetched, importance-ordered list plus
 * the host's `total` (which can exceed `prs.length` for a long-lived branch — it
 * drives the badge's `+N` and the hovercard's "view all" link).
 */
export interface BranchPrs {
  prs: PullRequestInfo[]
  total: number
}

/**
 * Importance rank for the badge: the actionable open PR first, then a draft,
 * then the historical merged and closed ones. Lower sorts first.
 */
export function prRank(pr: PullRequestInfo): number {
  if (pr.state === 'open') return pr.draft ? 1 : 0
  if (pr.state === 'merged') return 2
  return 3
}

/**
 * Group a flat PR list by head branch and order each branch's PRs by importance,
 * with ties keeping the input order (the API hands them back most-recent-first).
 * Cross-repo PRs are dropped: a fork PR's head ref names a branch in another
 * repo, so matching it to a local branch by name alone would be wrong.
 */
export function groupPrsByBranch(prs: PullRequestInfo[]): Map<string, PullRequestInfo[]> {
  const byBranch = new Map<string, PullRequestInfo[]>()
  for (const pr of prs) {
    if (pr.isCrossRepo) continue
    const list = byBranch.get(pr.headBranch)
    if (list) list.push(pr)
    else byBranch.set(pr.headBranch, [pr])
  }
  // Array.sort is stable, so equal ranks keep their most-recent-first order.
  for (const list of byBranch.values()) list.sort((a, b) => prRank(a) - prRank(b))
  return byBranch
}
