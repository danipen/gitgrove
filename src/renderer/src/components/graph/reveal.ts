// Revealing something in the Graph from elsewhere (the command palette): which
// row or node a branch/commit target lands on in the current layout. Pure, so
// the matching rules are tested without a canvas.

import type { GraphLayout, GraphNode, GraphRow } from './layout'

export type GraphRevealTarget =
  /** A branch ref by its full short name (`feature/x`, `origin/feature/x`)
   *  and the commit it points at. */
  { kind: 'branch'; name: string; hash: string } | { kind: 'commit'; hash: string }

/** A reveal request; the nonce makes asking for the same target again fire. */
export interface GraphRevealRequest {
  target: GraphRevealTarget
  nonce: number
}

export type RevealHit = { kind: 'row'; row: GraphRow } | { kind: 'node'; node: GraphNode }

/**
 * Where `target` is in `layout`, or null when the loaded window doesn't show
 * it. A branch resolves to its row — rows are named by base name (`origin/x`
 * and `x` share one), and when a diverged branch has several rows of that
 * name, the one whose tip is the ref's commit wins. A branch whose row is
 * gone but whose tip commit is still drawn falls back to that commit.
 */
export function resolveReveal(
  target: GraphRevealTarget,
  layout: GraphLayout,
  remotes: readonly string[]
): RevealHit | null {
  if (target.kind === 'branch') {
    const remote = remotes.find((r) => target.name.startsWith(`${r}/`))
    const base = remote ? target.name.slice(remote.length + 1) : target.name
    const named = layout.rows.filter(
      (row) => row.name === base && (row.kind === 'branch' || row.kind === 'remote')
    )
    const row = named.find((r) => r.tipHash === target.hash) ?? named[0]
    if (row) return { kind: 'row', row }
  }
  const node = layout.nodeByHash.get(target.hash)
  return node ? { kind: 'node', node } : null
}
