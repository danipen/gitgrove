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
//   itself a taller diagram. Footprints themselves are zoned (see PackChain)
//   so row-sharing is exactly as tight as the pixels allow — a label pill
//   hanging over a neighbor's merge lead-out shares the row instead of
//   dropping below it for a touch no eye can see.
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

/** One chain as the packer sees it. Its footprint has two layers, matching
 *  what the renderer actually draws (see geometry.ts labelRect):
 *
 *  On the row spine —
 *    [start … capStart-1]  fork lead-in run (a connector line)
 *    [capStart … capEnd]   capsule: the commits and spine
 *    [capEnd+1 … end]      breathing column + merge lead-out run
 *
 *  In the label band above it —
 *    [capStart … labelEnd] the label pill, anchored at the first commit and
 *                          extending RIGHT — past the capsule when the name
 *                          outsizes a short branch.
 *
 *  Zones let row-sharing be exactly as tight as the pixels allow: nothing
 *  solid may overlap a capsule, and two pills may not collide, but a pill
 *  MAY hang over a neighbor's connector runs — its opaque base masks the
 *  line behind it, so no ink is lost. That relaxation lets a branch tuck
 *  beside a neighbor whose lead-out barely grazes it, instead of dropping a
 *  whole row for a touch no eye can see. */
export interface PackChain {
  id: number
  /** The connector-line footprint on the spine: lead-in … lead-out. */
  start: number
  end: number
  /** The capsule zone. layout.ts always leaves end ≥ capEnd + 1. */
  capStart: number
  capEnd: number
  /** Right edge of the label pill (estimated — see layout.ts), ≥ capStart. */
  labelEnd: number
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

/** Improvement sweeps before the pass stops. Each accepted change strictly
 *  shrinks the objective, so the pass converges — usually in one or two. */
const MAX_SWEEPS = 3

/** Work units (≈ inner-loop operations) each clarity phase may spend —
 *  packing's crossing scoring and the improvement pass each get one cap.
 *  When a phase runs out it degrades gracefully (plain first-fit placement /
 *  no further moves), keeping layout to a few milliseconds even on
 *  pathological windows — thousands of overlapping chains — where polishing
 *  a graph that's unreadable at that scale isn't worth the time; every
 *  human-readable graph finishes well inside the cap. */
const PHASE_WORK_CAP = 1_500_000

const NOT_RELEASE = Number.MAX_SAFE_INTEGER

/** A vertical connector with both ends known: `a`/`b` are chain ids (the
 *  mainline included), deduplicated from the two chains' mirrored stubs. */
interface Vertical {
  column: number
  a: number
  b: number
}

/** Whether two footprints may NOT share a row (see PackChain's zones):
 *  a capsule tolerates nothing over it — not lines, not pills, not another
 *  capsule (the breathing column keeps them a col apart) — and two pills
 *  must not collide in the label band. Everything else overlaps freely:
 *  pills over connector runs, run over run. */
const conflicts = (a: PackChain, b: PackChain): boolean =>
  (a.capStart <= b.end && b.start <= a.capEnd) || // a's capsule vs b's lines
  (b.capStart <= a.end && a.start <= b.capEnd) || // b's capsule vs a's lines
  // Label band: each chain's solid extent is its pill plus its capsule.
  (a.capStart <= Math.max(b.labelEnd, b.capEnd) && b.capStart <= Math.max(a.labelEnd, a.capEnd))

/**
 * Pack every chain onto a row. `chains` excludes the mainline; `mainId` (the
 * mainline's chain id, or -1 when there is none) is seeded onto row 0 so
 * floors and connector spans can resolve against it. Returns chain id → row.
 */
export function packRows(chains: readonly PackChain[], mainId: number): Map<number, number> {
  const rowOf = pack(chains, mainId)
  improvePlacement(chains, mainId, rowOf)
  compactRows(rowOf)
  return rowOf
}

/** Drop row numbers that ended up unused (lifts can empty a row out), so the
 *  diagram never renders a blank lane. Row 0 stays the mainline's. */
function compactRows(rowOf: Map<number, number>): void {
  const used = [...new Set([0, ...rowOf.values()])].sort((x, y) => x - y)
  if (used[used.length - 1] === used.length - 1) return // already dense
  const remap = new Map(used.map((row, index) => [row, index]))
  for (const [id, row] of rowOf) rowOf.set(id, remap.get(row) ?? row)
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
  const taken: PackChain[][] = [[]]
  const through: number[][] = []

  const fits = (row: number, c: PackChain): boolean => !taken[row]?.some((t) => conflicts(c, t))
  // A vertical crosses a chain where it would cut visible ink: the capsule
  // or the lead-out run. Verticals behind the label pill are masked by its
  // opaque base — pricing those would make chains dodge crossings no eye
  // can see.
  const covered = (row: number, column: number): boolean =>
    taken[row]?.some((t) => t.capStart <= column && column <= t.end) === true

  // Crossings placing `c` at `row` would create, both ways: its verticals
  // against placed rows, and placed verticals against its footprint. Charges
  // the work budget; once spent, scoring reports ties and placement degrades
  // to plain first-fit (see PHASE_WORK_CAP).
  let work = PHASE_WORK_CAP
  const crossings = (c: PackChain, row: number): number => {
    if (work <= 0) return 0
    let cost = 0
    const throughRow = through[row] ?? []
    work -= throughRow.length
    for (const column of throughRow) {
      if (column >= c.capStart && column <= c.end) cost++
    }
    for (const stub of c.stubs) {
      const otherRow = rowOf.get(stub.other)
      if (otherRow === undefined) continue
      const hi = Math.max(otherRow, row)
      for (let q = Math.min(otherRow, row) + 1; q < hi; q++) {
        work -= taken[q]?.length ?? 1
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
    taken[row].push(chain)
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

/** The improvement pass, two bounded local moves over the packed rows:
 *
 *  - SWAPS of strictly-nested, row-inverted chain pairs whenever that
 *    strictly reduces crossings (see header, CLARITY 2).
 *  - LIFTS: greedy packing is placement-order myopic — a chain may sit low
 *    because the rows above were busy when its turn came, even though later
 *    swaps and lifts freed them. Each sweep re-offers every chain the rows
 *    above it and moves it up whenever it fits, floors hold, and its
 *    crossings don't get worse — reclaiming the wasted vertical space for
 *    free.
 *
 *  Every accepted change strictly shrinks (crossings, total row distance)
 *  lexicographically, so the pass converges; MAX_SWEEPS caps it anyway.
 *  Mutates rowOf. */
function improvePlacement(
  chains: readonly PackChain[],
  mainId: number,
  rowOf: Map<number, number>
): void {
  // Every vertical with both ends placed, deduplicated by (pair, column):
  // mirrored stubs collapse to one segment, and two merges of the same pair
  // at one column draw as one line — one crossing, not two.
  const verticals: Vertical[] = []
  const seen = new Set<string>()
  for (const c of chains) {
    for (const stub of c.stubs) {
      if (!rowOf.has(stub.other) || stub.other === c.id) continue
      const a = Math.min(c.id, stub.other)
      const b = Math.max(c.id, stub.other)
      const key = `${a}:${b}:${stub.column}`
      if (seen.has(key)) continue
      seen.add(key)
      verticals.push({ column: stub.column, a, b })
    }
  }
  const children = new Map<number, PackChain[]>()
  for (const c of chains) {
    if (c.parent === null) continue
    let list = children.get(c.parent)
    if (!list) children.set(c.parent, (list = []))
    list.push(c)
  }

  /** rowOf with up to two overrides — how a candidate move sees the rows. */
  const at =
    (aId: number, aRow: number, bId: number, bRow: number) =>
    (id: number): number =>
      id === aId ? aRow : id === bId ? bRow : (rowOf.get(id) ?? 0)

  /** Crossings involving the `moved` chains under `rowAt`'s rows — the only
   *  terms a local move can change, counted from scratch so the pass needs
   *  no incremental bookkeeping beyond rowOf itself. */
  const localCost = (moved: readonly PackChain[], rowAt: (id: number) => number): number => {
    // Same visible-ink rule as pack(): capsule + lead-out run, pads free.
    const crosses = (v: Vertical, z: PackChain): boolean => {
      if (z.id === v.a || z.id === v.b) return false
      if (v.column < z.capStart || v.column > z.end) return false
      const rz = rowAt(z.id)
      const ra = rowAt(v.a)
      const rb = rowAt(v.b)
      return Math.min(ra, rb) < rz && rz < Math.max(ra, rb)
    }
    let cost = 0
    for (const v of verticals) {
      if (moved.some((m) => m.id === v.a || m.id === v.b)) {
        for (const z of chains) if (crosses(v, z)) cost++
      } else {
        for (const m of moved) if (crosses(v, m)) cost++
      }
    }
    return cost
  }

  const fitsAt = (c: PackChain, row: number, ignoring: PackChain): boolean =>
    !chains.some(
      (z) => z.id !== c.id && z.id !== ignoring.id && rowOf.get(z.id) === row && conflicts(c, z)
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

  const movable = chains
    .filter((c) => c.releaseRank === null && rowOf.has(c.id))
    .sort((a, b) => a.start - b.start || a.id - b.id)
  const evalCost = chains.length + verticals.length + 1
  let work = PHASE_WORK_CAP
  for (let sweep = 0; sweep < MAX_SWEEPS && work > 0; sweep++) {
    let improved = false
    // ── Swaps: `o`'s footprint contains `i`'s, yet `o` sits above it.
    // The start-sorted list keeps containment scans short.
    for (let x = 0; x < movable.length && work > 0; x++) {
      const o = movable[x]
      for (let y = x + 1; y < movable.length && work > 0; y++) {
        work--
        const i = movable[y]
        if (i.start > o.end) break // sorted: nothing later can nest in o
        if (i.end > o.end) continue
        const rowO = rowOf.get(o.id) ?? 0
        const rowI = rowOf.get(i.id) ?? 0
        if (rowO >= rowI) continue
        work -= 3 * evalCost
        if (!fitsAt(o, rowI, i) || !fitsAt(i, rowO, o)) continue
        if (!floorsHold(o, rowI, i.id, rowO) || !floorsHold(i, rowO, o.id, rowI)) continue
        // Drift penalties cancel exactly (the pair trades distances), so a
        // swap is judged on crossings alone — and only a STRICT win moves.
        const kept = localCost([o, i], at(o.id, rowO, i.id, rowI))
        const swapped = localCost([o, i], at(o.id, rowI, i.id, rowO))
        if (swapped < kept) {
          rowOf.set(o.id, rowI)
          rowOf.set(i.id, rowO)
          improved = true
        }
      }
    }
    // ── Lifts: re-offer every chain the rows above it (placement scoring,
    // full hindsight). Move up only when crossings don't get worse.
    for (const c of movable) {
      if (work <= 0) break
      const current = rowOf.get(c.id) ?? 0
      const parentRow = c.parent === null ? 0 : (rowOf.get(c.parent) ?? 0)
      const currentCost = localCost([c], at(c.id, current, c.id, current))
      let bestRow = current
      let bestScore = currentCost + (current - parentRow - 1) * ROW_DRIFT_PENALTY
      for (let r = parentRow + 1; r < current && work > 0; r++) {
        work -= evalCost
        if (!fitsAt(c, r, c)) continue
        const cost = localCost([c], at(c.id, r, c.id, r))
        const score = cost + (r - parentRow - 1) * ROW_DRIFT_PENALTY
        if (cost <= currentCost && score < bestScore) {
          bestRow = r
          bestScore = score
          if (cost === 0) break // nothing above can score lower
        }
      }
      if (bestRow !== current) {
        rowOf.set(c.id, bestRow)
        improved = true
      }
    }
    if (!improved) break
  }
}
