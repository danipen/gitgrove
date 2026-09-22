// Which pull requests each Graph row shows, merged from two sources:
//   • the host's live answer for a named branch (open/draft/merged/closed + CI),
//     fetched on demand for labels on screen (usePullRequests);
//   • the PR its landing commit recorded in history (layout.ts landedPr) — how
//     a deleted, merged branch still names its PR, with no API call at all.
// The host wins when it knows the branch: it's the fresher, richer answer.
// Pure, so the precedence is unit-tested directly.

import { pullRequestUrl } from '@shared/git-host-urls'
import type { PullRequestInfo } from '@shared/types'
import type { BranchPrs } from '@/lib/pr-order'
import type { LandedPr } from './landedPr'
import type { GraphRow } from './layout'

/** Rows the host can be asked about: those naming a real ref. Deleted
 *  branches (unnamed rows) have nothing left on the host to look up by. */
export const isPrLookupRow = (row: GraphRow): boolean =>
  row.kind === 'branch' || row.kind === 'remote'

/** A PR recorded in history, shaped like a host answer so the chip, the
 *  hovercard and the detail pane render one type. It's merged by definition —
 *  the commit that recorded it is the landing. */
export function landedPrInfo(pr: LandedPr, headBranch: string, webUrl: string): PullRequestInfo {
  return {
    number: pr.number,
    state: 'merged',
    title: pr.title,
    url: pullRequestUrl(webUrl, pr.number),
    draft: false,
    headBranch,
    baseBranch: '',
    isCrossRepo: false,
    checks: null
  }
}

/**
 * Chain id → the PRs its label chip shows. `webUrl` is the repo's GitHub web
 * base (links for history-recorded PRs); null off GitHub, where no row gets a
 * chip — a `#N` that can't be opened is a promise the UI can't keep.
 */
export function rowPullRequests(
  rows: readonly GraphRow[],
  prByBranch: ReadonlyMap<string, BranchPrs>,
  webUrl: string | null
): Map<number, BranchPrs> {
  const byChain = new Map<number, BranchPrs>()
  if (!webUrl) return byChain
  for (const row of rows) {
    const hosted = isPrLookupRow(row) ? prByBranch.get(row.name) : undefined
    if (hosted && hosted.prs.length > 0) {
      byChain.set(row.chain, hosted)
      continue
    }
    if (row.landedPr) {
      byChain.set(row.chain, { prs: [landedPrInfo(row.landedPr, row.name, webUrl)], total: 1 })
    }
  }
  return byChain
}
