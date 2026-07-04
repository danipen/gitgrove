// The related set behind the Graph's "Focus on <branch>" verb: the branch
// itself, the branch it forked from, branches forked from it, and branches
// merge-connected to it — Plastic SCM's "related branches" as one gesture.
// Computed as a BFS over the layout's fork/merge edges, `hops` chains deep,
// on an UNFILTERED layout (so focus sees through the current filters). Feed
// the result to GraphInput.visibleBranches. Pure — no DOM, no git.

import type { GraphLayout } from './layout'

/**
 * Base branch names within `hops` fork/merge connections of `seed`. The seed
 * is always included. Unnamed chains (deleted branches) conduct relatedness
 * but cost a hop like everything else and never appear in the result — the
 * branch filter cannot address them anyway.
 */
export function relatedBranches(layout: GraphLayout, seed: string, hops: number): Set<string> {
  // Chain-level adjacency from the node-level fork/merge edges. 'line' edges
  // stay within one chain by definition and carry no relatedness.
  const adjacency = new Map<number, Set<number>>()
  const connect = (a: number, b: number) => {
    let peers = adjacency.get(a)
    if (!peers) {
      peers = new Set()
      adjacency.set(a, peers)
    }
    peers.add(b)
  }
  for (const edge of layout.edges) {
    if (edge.kind === 'line') continue
    const from = layout.nodeByHash.get(edge.fromHash)?.chain
    const to = layout.nodeByHash.get(edge.toHash)?.chain
    if (from === undefined || to === undefined || from === to) continue
    connect(from, to)
    connect(to, from)
  }
  // Empty lanes (zero-commit branches) own no nodes, so their fork connector
  // maps to the anchor's chain on both ends above — relate them to the chain
  // owning the commit they point at explicitly.
  for (const row of layout.rows) {
    if (!row.empty) continue
    const anchor = layout.nodeByHash.get(row.tipHash)?.chain
    if (anchor === undefined || anchor === row.chain) continue
    connect(row.chain, anchor)
    connect(anchor, row.chain)
  }

  const nameOf = new Map<number, string>()
  const seeds: number[] = []
  for (const row of layout.rows) {
    if (row.kind !== 'branch' && row.kind !== 'remote') continue
    nameOf.set(row.chain, row.name)
    // A diverged local/remote pair yields two chains with one base name —
    // both seed the walk, so focus covers the whole branch.
    if (row.name === seed) seeds.push(row.chain)
  }

  const names = new Set<string>([seed])
  const visited = new Set<number>(seeds)
  const queue = seeds.map((chain) => ({ chain, depth: 0 }))
  for (let i = 0; i < queue.length; i++) {
    const { chain, depth } = queue[i]
    const name = nameOf.get(chain)
    if (name !== undefined) names.add(name)
    if (depth === hops) continue
    for (const next of adjacency.get(chain) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push({ chain: next, depth: depth + 1 })
    }
  }
  return names
}
