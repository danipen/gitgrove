// Pull requests recorded in history: GitHub writes the PR number into the
// commit that lands it, so a merged PR is readable straight from the loaded
// log — no API call, no account, works offline. Two shapes cover GitHub's
// merge buttons:
//   • "Create a merge commit": subject `Merge pull request #89 from owner/branch`,
//     body = the PR title;
//   • "Squash and merge" (and the default squash title): subject `Title (#89)`.
// ("Rebase and merge" records nothing — those land with no PR trace.)
// Pure — the layout and detail pane both call it.

import type { Commit } from '@shared/types'

/** A pull request as its landing commit records it. */
export interface LandedPr {
  number: number
  /** The PR title: the merge commit's body line, or the squash subject. */
  title: string
}

// The owner segment can't contain '/', so everything after the first slash is
// the branch — which itself may be nested (`feature/x/y`).
const MERGE_PR = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/
const SQUASH_PR = /^(.*\S)\s+\(#(\d+)\)$/

/** The head branch named by a GitHub PR merge subject, or null. */
export function branchFromPrMergeSubject(subject: string): string | null {
  return subject.match(MERGE_PR)?.[2] ?? null
}

/** The PR a commit landed, when its message records one (see file header). */
export function landedPrOf(commit: Commit): LandedPr | null {
  const merge = commit.subject.match(MERGE_PR)
  if (merge) {
    const title = commit.body.split('\n').find((line) => line.trim() !== '')
    return { number: Number(merge[1]), title: title?.trim() ?? commit.subject }
  }
  const squash = commit.subject.match(SQUASH_PR)
  if (squash) return { number: Number(squash[2]), title: squash[1] }
  return null
}
