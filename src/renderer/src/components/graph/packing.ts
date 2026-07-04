// Row packing for the Graph tab: assigns every reconstructed chain a packed
// row below the mainline, reusing rows wherever column footprints allow.
// Pure — no DOM, no git — and driven entirely by the footprints and connector
// stubs layout.ts hands it, so it's unit-testable in isolation.
//
// Two forces shape the arrangement, strictly in this order:
//
// - DENSITY. Chains pack first-fit in fork order (the left-edge rule — the
//   row count stays minimal for the footprints given), and a chain never
//   opens a new row while an existing row can host it: clarity never buys
//   itself a taller diagram.
// - CLARITY. Every chain hangs off the diagram by a handful of VERTICAL
//   connectors (the fork drop from its parent, the merge lead-out into its
//   target, one per merge it received — see render.ts for the orthogonal
//   routing), and each vertical crosses every row it passes whose footprint
//   covers its column. Two mechanisms cut those crossings without touching
//   the row count:
//     1. Placement drift — among the rows that FIT, take the one whose
//        connectors cross the least (the chain's own verticals against the
//        rows already placed, and the already-placed verticals against the
//        footprint the chain would lay down). A farther row wins only when
//        the saved crossings outweigh the drift from the parent
//        (ROW_DRIFT_PENALTY) — e.g. a backport slides down to hug the
//        release line it merges into.
//     2. Nested-pair swaps — fork-order packing puts a long-lived branch
//        ABOVE the short branches that fork and merge back entirely inside
//        its lifetime, so every short branch's connectors slice through the
//        long capsule. A bounded post-pass swaps such pairs (long one sinks,
//        family rises) whenever that strictly reduces crossings: the long
//        branch's verticals fall outside the family's spans, and a fully
//        nested family unwinds to zero crossings. Swaps exchange existing
//        rows, so density is untouched by construction.
//
// Hard constraints, never traded: the mainline owns row 0 alone; release
// lines stack directly beneath it in version order (pure first-fit, no drift,
// no swaps — their rows are a stable spine the eye navigates by); a child
// chain always packs strictly below its fork parent.

/** A vertical connector this chain shares with another chain: the fork drop
 *  from its parent, its merge lead-out, or a merge it received. */
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

/** Swap sweeps before the improvement pass stops. Each accepted swap
 *  strictly reduces crossings, so the pass converges — usually in one. */
const MAX_SWEEPS = 3

/** Swap evaluations before the improvement pass bails, and the total work
 *  those evaluations may cost (each is an O(chains + verticals) scan). The
 *  work cap shrinks the budget on pathological windows — thousands of
 *  overlapping chains — where the pass would burn tens of milliseconds
 *  polishing a graph that's unreadable at that scale anyway; every
 *  human-readable graph gets the full budget many times over. */
const SWAP_BUDGET = 4000
const SWAP_WORK_CAP = 1_500_000

const NOT_RELEASE = Number.MAX_SAFE_INTEGER

/** A vertical connector with both ends known: `a`/`b` are chain ids (the
 *  mainline included), deduplicated from the two chains' mirrored stubs. */
interface Vertical {
  column: number
  a: number
  b: number
}

/**
 * Pack every chain onto a row. `chains` excludes the mainline; `mainId` (the
 * mainline's chain id, or -1 when there is none) is seeded onto row 0 so
 * floors and connector spans can resolve against it. Returns chain id → row.
 */
export function packRows(chains: readonly PackChain[], mainId: number): Map<number, number> {
  const rowOf = pack(chains, mainId)
  swapNestedPairs(chains, mainId, rowOf)
  return rowOf
}

/** First-fit packing in fork order, with crossing-aware drift (see header). */
function pack(chains: readonly PackChain[], mainId: number): Map<number, number> {
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
  // fork depth, HEAD's chain first within its depth, then by start column so
  // packing stays dense, ids last for determinism.
  const order = [...chains].sort(
    (a, b) =>
      (a.releaseRank ?? NOT_RELEASE) - (b.releaseRank ?? NOT_RELEASE) ||
      depthOf(a.id) - depthOf(b.id) ||
      Number(b.isHead) - Number(a.isHead) ||
      a.start - b.start ||
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

  // Crossings placing `c` at `row` would create, both ways: its verticals
  // against placed rows, and placed verticals against its footprint.
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
      // candidate only when no existing row fits — see DENSITY above.
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

/** The improvement pass: swap strictly-nested, row-inverted chain pairs
 *  whenever that reduces crossings (see header, CLARITY 2). Mutates rowOf. */
function swapNestedPairs(
  chains: readonly PackChain[],
  mainId: number,
  rowOf: Map<number, number>
): void {
  // Every vertical with both ends in the window, deduplicated: each pair's
  // stubs mirror each other, so take a vertical from its lower-id end (the
  // mainline carries no stub list — its verticals come from the other end).
  const verticals: Vertical[] = []
  for (const c of chains) {
    for (const stub of c.stubs) {
      if ((c.id < stub.other || stub.other === mainId) && rowOf.has(stub.other)) {
        verticals.push({ column: stub.column, a: c.id, b: stub.other })
      }
    }
  }
  const children = new Map<number, PackChain[]>()
  for (const c of chains) {
    if (c.parent === null) continue
    let list = children.get(c.parent)
    if (!list) children.set(c.parent, (list = []))
    list.push(c)
  }

  /** Crossings involving `o` or `i` if they sat on (rowO, rowI) — the only
   *  terms a swap can change, counted from scratch so the pass needs no
   *  incremental bookkeeping beyond rowOf itself. */
  const pairCost = (o: PackChain, i: PackChain, rowO: number, rowI: number): number => {
    const rowAt = (id: number): number =>
      id === o.id ? rowO : id === i.id ? rowI : (rowOf.get(id) ?? 0)
    const crossesInterval = (v: Vertical, z: PackChain): boolean => {
      if (z.id === v.a || z.id === v.b) return false
      if (v.column < z.start || v.column > z.end) return false
      const rz = rowAt(z.id)
      const ra = rowAt(v.a)
      const rb = rowAt(v.b)
      return Math.min(ra, rb) < rz && rz < Math.max(ra, rb)
    }
    let cost = 0
    for (const v of verticals) {
      if (v.a === o.id || v.b === o.id || v.a === i.id || v.b === i.id) {
        for (const z of chains) if (crossesInterval(v, z)) cost++
      } else {
        if (crossesInterval(v, o)) cost++
        if (crossesInterval(v, i)) cost++
      }
    }
    return cost
  }

  const fitsAt = (c: PackChain, row: number, ignoring: PackChain): boolean =>
    !chains.some(
      (z) =>
        z.id !== c.id &&
        z.id !== ignoring.id &&
        rowOf.get(z.id) === row &&
        c.start <= z.end &&
        z.start <= c.end
    )
  /** Parent above, every child below — with the pair's swapped rows. */
  const floorsHold = (c: PackChain, row: number, otherId: number, otherRow: number): boolean => {
    const rowAt = (id: number): number | undefined =>
      id === otherId ? otherRow : rowOf.get(id)
    const parentRow = c.parent === null ? 0 : (rowAt(c.parent) ?? 0)
    if (row <= parentRow) return false
    return (children.get(c.id) ?? []).every((child) => {
      const childRow = rowAt(child.id)
      return childRow === undefined || childRow > row
    })
  }

  // Candidate pairs: `o`'s footprint contains `i`'s, yet `o` sits above it.
  // Sorted by start so containment scans stay short.
  const movable = chains
    .filter((c) => c.releaseRank === null && rowOf.has(c.id))
    .sort((a, b) => a.start - b.start || a.id - b.id)
  let budget = Math.min(
    SWAP_BUDGET,
    Math.ceil(SWAP_WORK_CAP / (chains.length + verticals.length + 1))
  )
  for (let sweep = 0; sweep < MAX_SWEEPS && budget > 0; sweep++) {
    let improved = false
    for (let x = 0; x < movable.length && budget > 0; x++) {
      const o = movable[x]
      for (let y = x + 1; y < movable.length && budget > 0; y++) {
        const i = movable[y]
        if (i.start > o.end) break // sorted: nothing later can nest in o
        if (i.end > o.end) continue
        const rowO = rowOf.get(o.id) ?? 0
        const rowI = rowOf.get(i.id) ?? 0
        if (rowO >= rowI) continue
        budget--
        if (!fitsAt(o, rowI, i) || !fitsAt(i, rowO, o)) continue
        if (!floorsHold(o, rowI, i.id, rowO) || !floorsHold(i, rowO, o.id, rowI)) continue
        // Drift penalties cancel exactly (the pair trades distances), so a
        // swap is judged on crossings alone — and only a STRICT win moves.
        if (pairCost(o, i, rowI, rowO) < pairCost(o, i, rowO, rowI)) {
          rowOf.set(o.id, rowI)
          rowOf.set(i.id, rowO)
          improved = true
        }
      }
    }
    if (!improved) break
  }
}
