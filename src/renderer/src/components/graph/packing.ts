// Row packing for the Graph tab: assigns every reconstructed chain a packed
// row below the mainline, reusing rows wherever column footprints allow.
// Pure — no DOM, no git — and driven entirely by the footprints and connector
// stubs layout.ts hands it, so it's unit-testable in isolation.
//
// Two forces shape every placement, strictly in this order:
//
// - DENSITY. A chain never opens a new row while an existing row can host its
//   footprint — short-lived branches share rows instead of staircasing down
//   the canvas, and the diagram stays as compact as plain first-fit.
// - CLARITY. Among the rows that fit, take the one whose connector lines
//   cross the least. Every chain hangs off the diagram by a handful of
//   VERTICAL connectors (the fork drop from its parent, the merge lead-out
//   into its target, one per merge it received — see render.ts for the
//   orthogonal routing), and each vertical crosses every row it passes whose
//   footprint covers its column. Candidate rows are scored on both sides of
//   that relation: the chain's own verticals against the rows already placed,
//   and the already-placed verticals against the footprint the chain would
//   lay down. A lower-scoring row further from the parent wins only when the
//   saved crossings outweigh the drift (ROW_DRIFT_PENALTY).
//
// Placement order also serves clarity: within a fork depth, chains pack by
// MERGE column (footprint end), not fork column. A branch that merges back
// sooner sits closer to its parent, so a family of branches nested inside a
// long-lived one renders with the long one underneath — its verticals fall
// outside the short ones' spans and the family crosses nothing, where
// fork-order packing would slice every short branch's connectors through the
// long capsule. Nested lifetimes overlap pairwise, so this costs no rows.
//
// Hard constraints, never traded away: the mainline owns row 0 alone;
// release lines stack directly beneath it in version order (pure first-fit,
// no drift — their rows are a stable spine the eye navigates by); a child
// chain always packs strictly below its fork parent.

/** A vertical connector this chain shares with another chain: the fork drop
 *  from its parent, its merge lead-out, or a merge it received. Becomes a
 *  real segment (and starts costing crossings) once both ends are placed. */
export interface VerticalStub {
  /** Column the connector runs down. */
  column: number
  /** The chain on the connector's other end. */
  other: number
}

/** One chain as the packer sees it. */
export interface PackChain {
  id: number
  /** Reserved footprint: label pad + fork lead-in … merge lead-out. */
  start: number
  end: number
  /** Chain owning the commit this one forked from — its row floor — or null
   *  for a chain that starts at a root commit (or off-window). */
  parent: number | null
  /** Position in the release spine stack (0 = newest version), or null. */
  releaseRank: number | null
  /** The checked-out branch's chain: packs first within its fork depth. */
  isHead: boolean
  stubs: readonly VerticalStub[]
}

/** Crossings a row of drift must save to be worth moving away from the
 *  parent: one saved crossing justifies sliding up to two rows down, so
 *  children stay near their family unless moving genuinely clears lines. */
const ROW_DRIFT_PENALTY = 0.35

/** Fitting rows scored per chain. Bounds the cost work on huge (structure-
 *  only) graphs; with drift priced in, rows past the first few fits almost
 *  never win anyway. */
const MAX_CANDIDATES = 6

const NOT_RELEASE = Number.MAX_SAFE_INTEGER

/**
 * Pack every chain onto a row. `chains` excludes the mainline; `mainId` (the
 * mainline's chain id, or -1 when there is none) is seeded onto row 0 so
 * floors and connector spans can resolve against it. Returns chain id → row.
 */
export function packRows(chains: readonly PackChain[], mainId: number): Map<number, number> {
  const rowOf = new Map<number, number>()
  if (mainId >= 0) rowOf.set(mainId, 0)

  // Fork depth below the mainline (mainline 0, branches off it 1, …) orders
  // packing parent-before-child, so every child's floor row is already
  // resolved when its turn comes. Chains can't cycle (fork bases only point
  // at older columns), but the guard keeps a malformed input walk total.
  const byId = new Map(chains.map((c) => [c.id, c]))
  const depths = new Map<number, number>()
  const depthOf = (id: number): number => {
    if (id === mainId) return 0
    const cached = depths.get(id)
    if (cached !== undefined) return cached
    depths.set(id, 1)
    const parent = byId.get(id)?.parent
    const depth = parent == null ? 1 : depthOf(parent) + 1
    depths.set(id, depth)
    return depth
  }

  // Release lines first (newest version first — the spine stack), then by
  // fork depth, HEAD's chain first within its depth, then by merge column so
  // sooner-merged siblings pack nearer the parent (see the header), ids last
  // for determinism.
  const order = [...chains].sort(
    (a, b) =>
      (a.releaseRank ?? NOT_RELEASE) - (b.releaseRank ?? NOT_RELEASE) ||
      depthOf(a.id) - depthOf(b.id) ||
      Number(b.isHead) - Number(a.isHead) ||
      a.end - b.end ||
      a.id - b.id
  )

  // Occupied footprints per row (index 0 is the mainline's — never packed
  // into), and the columns of registered verticals passing THROUGH each row.
  // n chains → tiny arrays; linear scans stay cheap.
  const taken: { start: number; end: number }[][] = [[]]
  const through: number[][] = []

  const fits = (row: number, c: PackChain): boolean =>
    !taken[row]?.some((t) => c.start <= t.end && t.start <= c.end)
  const covered = (row: number, column: number): boolean =>
    taken[row]?.some((t) => t.start <= column && column <= t.end) === true

  /** Crossings placing `c` at `row` would create, both ways: its verticals
   *  against placed rows, and placed verticals against its footprint. */
  const crossings = (c: PackChain, row: number): number => {
    let cost = 0
    for (const column of through[row] ?? []) {
      if (column >= c.start && column <= c.end) cost++
    }
    for (const stub of c.stubs) {
      const otherRow = rowOf.get(stub.other)
      if (otherRow === undefined) continue
      const hi = Math.max(otherRow, row)
      for (let q = Math.min(otherRow, row) + 1; q < hi; q++) {
        if (covered(q, stub.column)) cost++
      }
    }
    return cost
  }

  for (const chain of order) {
    // A child never packs above its parent: candidates start strictly below
    // it. Release lines are exempt — their spine stack is fixed from row 1.
    const floor =
      chain.releaseRank !== null || chain.parent === null
        ? 1
        : (rowOf.get(chain.parent) ?? 0) + 1
    let row = floor
    if (chain.releaseRank !== null) {
      // Releases: pure first-fit. Cost-driven drift would let a busy window
      // shuffle the maintenance rows users navigate by.
      while (!fits(row, chain)) row++
    } else {
      // Gather the nearest fitting rows, then keep the cheapest; ties go to
      // the row nearest the parent. A NEW row (past the current edge) is a
      // candidate only when no existing row fits — clarity never buys itself
      // a taller diagram (density is the promise the packer keeps first).
      const candidates: number[] = []
      for (let r = floor; candidates.length < MAX_CANDIDATES; r++) {
        if (r >= taken.length) {
          if (candidates.length === 0) candidates.push(r)
          break
        }
        if (fits(r, chain)) candidates.push(r)
      }
      let best = Number.MAX_VALUE
      for (const r of candidates) {
        const cost = crossings(chain, r)
        const score = cost + (r - candidates[0]) * ROW_DRIFT_PENALTY
        if (score < best) {
          best = score
          row = r
        }
        // Candidates ascend, so later scores are at least their (larger)
        // drift: a crossing-free row this close can't be beaten.
        if (cost === 0) break
      }
    }

    rowOf.set(chain.id, row)
    while (taken.length <= row) taken.push([])
    taken[row].push({ start: chain.start, end: chain.end })
    // Register the verticals whose far end is now placed. Each registers
    // exactly once — from whichever end packs second (the mainline never
    // packs, so its connectors always register from the other end).
    for (const stub of chain.stubs) {
      const otherRow = rowOf.get(stub.other)
      if (otherRow === undefined || stub.other === chain.id) continue
      const hi = Math.max(otherRow, row)
      for (let q = Math.min(otherRow, row) + 1; q < hi; q++) {
        ;(through[q] ??= []).push(stub.column)
      }
    }
  }
  return rowOf
}
