// Backport twins: commits that share a patch-id are one change living on
// several lines — a cherry-picked backport. Twins are always on, but scoped
// to the chains backports actually live on (mainline + release lines), so a
// repo without release lines never pays for the patch-id pipeline. This file
// is the pure logic (unit-tested); useBackportLinks feeds it patch-ids from
// the main process and the canvas draws dots + on-demand curves.

import type { GraphNode, GraphRow } from './layout'
import { releaseVersionWithOverride } from './releases'

/** One dashed link between two commits carrying the same change. */
export interface BackportLink {
  /** Older end (leftmost column). */
  fromHash: string
  /** Newer end. */
  toHash: string
}

/**
 * Chains whose commits can carry backport twins: the mainline and the release
 * lines — backports live there by definition. Everything else (the bulk of
 * any window) never enters the patch-id pipeline.
 */
export function linkableChains(
  rows: readonly GraphRow[],
  defaultBranch: string | null,
  overrides?: ReadonlyMap<string, boolean> | null
): Set<number> {
  const chains = new Set<number>()
  for (const row of rows) {
    if (row.kind !== 'branch' && row.kind !== 'remote') continue
    if (
      row.name === defaultBranch ||
      releaseVersionWithOverride(row.name, overrides?.get(row.name)) !== null
    ) {
      chains.add(row.chain)
    }
  }
  return chains
}

/** The other ends of every link touching `hash` — where "Go to Twin" (the
 *  commit context menu, or T on the selected commit) jumps. */
export function twinHashes(links: readonly BackportLink[], hash: string): string[] {
  const twins: string[] = []
  for (const link of links) {
    if (link.fromHash === hash) twins.push(link.toHash)
    else if (link.toHash === hash) twins.push(link.fromHash)
  }
  return twins
}

/** Every commit that participates in at least one link — the nodes that wear
 *  the twin marker dot. */
export function linkedHashes(links: readonly BackportLink[]): Set<string> {
  const hashes = new Set<string>()
  for (const link of links) {
    hashes.add(link.fromHash)
    hashes.add(link.toHash)
  }
  return hashes
}

/**
 * Pair up nodes with equal patch-ids. A group is chained oldest → newest
 * (consecutive pairs — a change on main, 11.x and 10.x reads as one path, not
 * an n² triangle) and same-chain pairs are dropped: a change reapplied on its
 * own branch is plain history, not a backport.
 */
export function backportLinks(
  nodes: readonly GraphNode[],
  patchIds: ReadonlyMap<string, string>
): BackportLink[] {
  const groups = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    if (node.isMerge) continue
    const id = patchIds.get(node.commit.hash)
    if (!id) continue
    let group = groups.get(id)
    if (!group) groups.set(id, (group = []))
    group.push(node)
  }
  const links: BackportLink[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.column - b.column)
    for (let i = 1; i < group.length; i++) {
      if (group[i - 1].chain === group[i].chain) continue
      links.push({ fromHash: group[i - 1].commit.hash, toHash: group[i].commit.hash })
    }
  }
  return links
}
