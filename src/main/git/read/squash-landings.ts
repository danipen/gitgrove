// Squash and rebase merges leave no merge commit behind: the branch's changes
// land on the default branch as NEW commits, so its tip never becomes an
// ancestor of it and the Graph would draw a finished pull request as a live,
// unmerged branch. This recovers the landing by content instead of ancestry:
// a branch landed when some mainline commit newer than its merge base carries
// the same patch-id as either
//   - the branch's whole `base..tip` diff (a squash merge: one commit), or
//   - the tip commit itself (a rebase merge: the tip is replayed last).
// patch-id --stable ignores line numbers and whitespace, so the match
// survives the mainline moving on underneath the branch; a squash that needed
// conflict resolution changes the patch and honestly stays unmatched.
//
// The renderer computes the candidates (tips off the mainline plus their
// merge bases — all within the loaded window, see graph/squash.ts), so this
// costs three streamed patch-id passes, never a spawn per branch.

import type { SquashCandidate } from '@shared/types'
import { getPatchIds, getRangePatchIds } from './patch-ids'

export async function getSquashLandings(
  repoPath: string,
  mainline: string[],
  candidates: SquashCandidate[]
): Promise<Record<string, string>> {
  if (mainline.length === 0 || candidates.length === 0) return {}
  const positionOf = new Map(mainline.map((hash, i) => [hash, i]))
  // Only commits newer than a candidate's base can have landed it; a base
  // outside the list (off the first-parent chain) searches the whole list.
  const baseIndexOf = (c: SquashCandidate) => positionOf.get(c.base) ?? mainline.length
  const searched = mainline.slice(0, Math.max(...candidates.map(baseIndexOf)))
  const [mainlineIds, rangeIds, tipIds] = await Promise.all([
    getPatchIds(repoPath, searched),
    getRangePatchIds(repoPath, candidates),
    getPatchIds(
      repoPath,
      candidates.map((c) => c.tip)
    )
  ])

  // patch-id → mainline positions, oldest first: the FIRST landing of a
  // change is the one that merged the branch (a later revert-and-reapply
  // carries the same patch again).
  const positionsById = new Map<string, number[]>()
  for (let i = searched.length - 1; i >= 0; i--) {
    const id = mainlineIds[searched[i]]
    if (!id) continue
    const positions = positionsById.get(id) ?? []
    positions.push(i)
    positionsById.set(id, positions)
  }

  const landings: Record<string, string> = {}
  for (const candidate of candidates) {
    const baseIndex = baseIndexOf(candidate)
    const ids = [rangeIds[candidate.tip], tipIds[candidate.tip]]
    const position = ids
      .flatMap((id) => (id ? (positionsById.get(id) ?? []) : []))
      .find((i) => i < baseIndex)
    if (position !== undefined) landings[candidate.tip] = searched[position]
  }
  return landings
}
