// Pure layout for the Graph tab's branch diagram: turns a flat `--date-order`
// commit list (newest first, every commit before its parents — see
// main/git/read/graph.ts) into branch rows, columns (one per commit, oldest
// left) and typed edges. No DOM, no git — fully unit-testable.
//
// The model is Plastic SCM's branch explorer, adapted to git: git commits
// don't belong to a branch, so branches are reconstructed by walking
// first-parent chains down from each tip, in priority order (default branch
// first, so it owns the mainline spine; then the checked-out branch; then the
// rest, newest tip first). Local and remote refs with the same base name
// ("main" / "origin/main") share one chain — the walk starts at the newer tip
// and passes through the older one. Commits left unclaimed (their branch was
// deleted after merging) become "unnamed" chains, labelled from the merge
// commit's subject when it records the branch name.
//
// Rows are then PACKED: the mainline keeps row 0 to itself, and every other
// chain goes to the lowest row where its column span (plus room for its
// label) doesn't collide — so short-lived branches that never overlap in time
// share a row instead of staircasing down the canvas.

import type { Commit } from '@shared/types'
import { type CommitRef, parseRefs } from '@/lib/format'

export type GraphRowKind = 'branch' | 'remote' | 'detached' | 'unnamed'

/** How many branch colors the render palette cycles through. */
export const BRANCH_COLOR_COUNT = 9

/** One reconstructed branch: a chain of commits on a packed row. */
export interface GraphRow {
  /** Packed row position (0 = the mainline); rows can share a position. */
  index: number
  /** Display name: the branch's base name, or a derived one for unnamed rows. */
  name: string
  kind: GraphRowKind
  /** True for the row holding the checked-out commit. */
  isHead: boolean
  tipHash: string
  /** The commit this branch grew from (first parent of its oldest commit),
   *  or null for a chain that starts at a root commit. Feeds the
   *  branch-changes view: everything in `base..tip` is what the branch did. */
  baseHash: string | null
  /** Palette slot — stable per branch name, 0 reserved for the mainline. */
  color: number
  /** Inclusive column span of the row's nodes. */
  startColumn: number
  endColumn: number
}

export interface GraphNode {
  commit: Commit
  /** Packed row position of the node's chain. */
  row: number
  column: number
  /** Palette slot of the node's chain. */
  color: number
  refs: CommitRef[]
  isMerge: boolean
  /** The checked-out commit (HEAD) — gets the marker ring. */
  isHead: boolean
  /** Some parents fell outside the loaded window (draw a continuation stub). */
  truncated: boolean
}

export type GraphEdgeKind = 'line' | 'merge' | 'fork'

/** An edge from a child commit to one of its parents (newer → older). */
export interface GraphEdge {
  kind: GraphEdgeKind
  /** Palette slot: the branch the edge "belongs to" — the source branch for
   *  merges, the new branch for forks, the chain itself for lines. */
  color: number
  /** Child (newer) commit — lets the renderer dim edges with the filter. */
  fromHash: string
  /** Parent (older) commit. */
  toHash: string
  fromColumn: number
  fromRow: number
  toColumn: number
  toRow: number
}

export interface GraphLayout {
  /** One entry per chain, sorted by (row position, start column). */
  rows: GraphRow[]
  /** How many packed row positions the diagram uses. */
  rowCount: number
  /** Nodes in ascending column order (the renderer culls by column range). */
  nodes: GraphNode[]
  edges: GraphEdge[]
  columnCount: number
  nodeByHash: ReadonlyMap<string, GraphNode>
  /** The checked-out commit, or null when it isn't in the window. */
  headHash: string | null
}

export interface GraphInput {
  commits: Commit[]
  /** Remote names ("origin", …), to group `origin/foo` with `foo`. */
  remotes: string[]
  /** Checked-out branch short name; '' when unknown. */
  headBranch: string
  detached: boolean
  defaultBranch: string | null
  /**
   * Base branch names to show, or null for all. When set, commits not claimed
   * by a visible branch are dropped (columns re-pack densely), so filtering
   * never leaves anonymous debris rows behind.
   */
  visibleBranches?: ReadonlySet<string> | null
  /**
   * Drop branches whose tip is already merged into another branch, plus the
   * deleted-branch chains — the noise of a busy trunk-based repo. The default
   * and checked-out branches always stay.
   */
  hideMerged?: boolean
  /**
   * Keep only the commits that shape the diagram — branch tips and starts,
   * merges (and what they merged), tagged/decorated commits, HEAD — and
   * collapse the linear runs between them. Plastic's "relevant changes only":
   * what makes a 100k-commit repo readable.
   */
  structureOnly?: boolean
}

/** Columns reserved left of a chain's first node so its label never overlaps
 *  the previous chain sharing the row. */
const LABEL_PAD_COLUMNS = 3

/** A branch tip: one exact ref name resolved to the commit it points at. */
interface Tip {
  hash: string
  isRemote: boolean
  /** Position of the tip commit in the input list (0 = newest). */
  order: number
}

/** A reconstructed branch chain before packing. */
interface Chain {
  name: string
  kind: GraphRowKind
  tipHash: string
}

/** Strip a known remote prefix: `origin/foo` → base `foo`, marked remote. */
function splitRef(name: string, remotes: readonly string[]): { base: string; remote: boolean } {
  for (const remote of remotes) {
    if (name.startsWith(`${remote}/`)) return { base: name.slice(remote.length + 1), remote: true }
  }
  return { base: name, remote: false }
}

/** True when the raw `%D` decoration says HEAD points at this commit. */
function isHeadDecoration(refs: string): boolean {
  return refs.split(',').some((r) => r.trim() === 'HEAD' || r.trim().startsWith('HEAD ->'))
}

/** Branch name recorded in a merge commit's subject, if git's stock message. */
function branchNameFromMergeSubject(subject: string): string | null {
  const m = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)
  return m ? m[1] : null
}

/** Stable palette slot for a branch name (1..N-1; 0 is the mainline's). */
function colorForName(name: string): number {
  let hash = 5381
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0
  return 1 + (Math.abs(hash) % (BRANCH_COLOR_COUNT - 1))
}

/**
 * Base branch names present in the window, in the same priority order the
 * layout claims them — what the branch filter popover lists.
 */
export function collectBranchNames(input: GraphInput): string[] {
  return groupTips(input).map((g) => g.base)
}

/** Tips grouped by base name, in claim priority order. */
function groupTips(input: GraphInput): { base: string; tips: Tip[] }[] {
  const groups = new Map<string, Tip[]>()
  input.commits.forEach((commit, order) => {
    for (const ref of parseRefs(commit.refs)) {
      if (ref.isTag || ref.name === 'HEAD') continue
      const { base, remote } = splitRef(ref.name, input.remotes)
      let tips = groups.get(base)
      if (!tips) groups.set(base, (tips = []))
      tips.push({ hash: commit.hash, isRemote: remote, order })
    }
  })
  // Tips arrive newest-first already (commits are date-ordered); order groups:
  // default branch, then the checked-out branch, then by newest tip.
  const ordered = [...groups.entries()].sort((a, b) => a[1][0].order - b[1][0].order)
  const named = ordered.map(([base, tips]) => ({ base, tips }))
  const pin = (base: string | null) => {
    if (!base) return
    const i = named.findIndex((g) => g.base === base)
    if (i > 0) named.unshift(...named.splice(i, 1))
  }
  pin(input.headBranch || null)
  pin(input.defaultBranch)
  return named
}

export function layoutGraph(input: GraphInput): GraphLayout {
  const { commits, visibleBranches } = input
  const commitByHash = new Map<string, Commit>()
  const orderOf = new Map<string, number>()
  commits.forEach((c, i) => {
    commitByHash.set(c.hash, c)
    orderOf.set(c.hash, i)
  })

  const headHash = commits.find((c) => isHeadDecoration(c.refs))?.hash ?? null

  // Every non-first parent: the commits merges pulled in. Drives hideMerged
  // (a tip that is a merge source has been merged), structureOnly (merge
  // sources are structure), unnamed-chain naming, and the merge lead-out each
  // chain's packing interval reserves.
  const mergeSources = new Set<string>()
  const mergeChildOf = new Map<string, Commit>()
  for (const c of commits) {
    for (const parent of c.parents.slice(1)) {
      mergeSources.add(parent)
      if (!mergeChildOf.has(parent)) mergeChildOf.set(parent, c)
    }
  }

  // ── Claim commits into chains by walking first parents down from each tip ──
  const chains: Chain[] = []
  const chainOf = new Map<string, number>()
  const claim = (tipHash: string, chain: Chain): boolean => {
    let hash: string | undefined = tipHash
    let claimed = false
    while (hash !== undefined && commitByHash.has(hash) && !chainOf.has(hash)) {
      chainOf.set(hash, chains.length)
      claimed = true
      hash = commitByHash.get(hash)?.parents[0]
    }
    if (claimed) chains.push(chain)
    return claimed
  }

  for (const group of groupTips(input)) {
    if (visibleBranches && !visibleBranches.has(group.base)) continue
    if (
      input.hideMerged &&
      group.base !== input.defaultBranch &&
      group.base !== input.headBranch &&
      mergeSources.has(group.tips[0].hash)
    ) {
      continue
    }
    const hasLocalRef = group.tips.some((t) => !t.isRemote)
    // The newest tip's walk usually passes through the older ones (local behind
    // remote). A genuinely diverged older tip starts its own row, same name.
    for (const tip of group.tips) {
      claim(tip.hash, {
        name: group.base,
        kind: hasLocalRef ? 'branch' : 'remote',
        tipHash: tip.hash
      })
    }
  }

  // A detached HEAD sitting off every branch gets its own row; parked on a
  // branch commit it's just the marker ring on that node.
  if (input.detached && headHash && !chainOf.has(headHash)) {
    claim(headHash, { name: 'HEAD', kind: 'detached', tipHash: headHash })
  }

  // ── Unclaimed commits: deleted-branch chains, named from their merge ──────
  // (Filtering drops them instead — they belong to branches filtered out;
  // hideMerged drops them too: a deleted branch is merged by definition.)
  if (!visibleBranches && !input.hideMerged) {
    for (const c of commits) {
      if (chainOf.has(c.hash)) continue
      const mergeChild = mergeChildOf.get(c.hash)
      const name = (mergeChild && branchNameFromMergeSubject(mergeChild.subject)) ?? c.shortHash
      claim(c.hash, { name, kind: 'unnamed', tipHash: c.hash })
    }
  }

  // ── Structure-only: collapse the linear runs between structural commits ───
  // A commit survives when it shapes the graph: chain tip or start, merge,
  // merge source, fork point (a commit some branch grew from), decorated
  // (branch/tag labels), or HEAD. Everything between two survivors on a chain
  // is dropped; edge building below bridges across the gap.
  let structural: ReadonlySet<string> | null = null
  if (input.structureOnly) {
    const oldestOf: (Commit | null)[] = chains.map(() => null)
    for (const c of commits) {
      const id = chainOf.get(c.hash)
      if (id !== undefined) oldestOf[id] = c // newest-first walk: last hit wins
    }
    const structuralHashes = new Set<string>(chains.map((chain) => chain.tipHash))
    for (const oldest of oldestOf) {
      if (!oldest) continue
      structuralHashes.add(oldest.hash)
      const forkPoint = oldest.parents[0]
      if (forkPoint) structuralHashes.add(forkPoint)
    }
    for (const c of commits) {
      if (c.parents.length > 1 || c.refs !== '' || mergeSources.has(c.hash)) {
        structuralHashes.add(c.hash)
      }
    }
    structural = structuralHashes
  }

  // ── Columns: dense re-pack of the kept commits, oldest at column 0 ────────
  const kept = commits.filter(
    (c) => chainOf.has(c.hash) && (structural === null || structural.has(c.hash))
  )
  const columnOf = new Map<string, number>()
  kept.forEach((c, i) => columnOf.set(c.hash, kept.length - 1 - i))

  // ── Chain spans + base hashes (oldest kept commit per chain) ──────────────
  const span = chains.map(() => ({
    start: Number.MAX_SAFE_INTEGER,
    end: -1,
    oldest: null as Commit | null
  }))
  // kept is newest-first, so the last hit per chain is its oldest commit.
  for (const c of kept) {
    const s = span[chainOf.get(c.hash) ?? 0]
    const column = columnOf.get(c.hash) ?? 0
    s.start = Math.min(s.start, column)
    s.end = Math.max(s.end, column)
    s.oldest = c
  }

  // ── Row packing: mainline alone on row 0; everyone else first-fit below ───
  // "As near to main as possible": each chain takes the lowest row whose
  // occupied column intervals don't collide with its own (padded for the
  // label). The HEAD chain is placed first so it lands closest to the top.
  const headChain = headHash !== null ? chainOf.get(headHash) : undefined
  const defaultChain = chains.findIndex(
    (c) => c.name === input.defaultBranch && c.kind !== 'unnamed'
  )
  const mainChain = defaultChain !== -1 ? defaultChain : (headChain ?? (chains.length > 0 ? 0 : -1))
  const rowOfChain = new Map<number, number>()
  if (mainChain >= 0) rowOfChain.set(mainChain, 0)
  const others = chains
    .map((_, id) => id)
    .filter((id) => id !== mainChain)
    .sort((a, b) => {
      // HEAD's chain first, then by start column so packing stays dense.
      if (a === headChain) return -1
      if (b === headChain) return 1
      return span[a].start - span[b].start
    })
  // Occupied intervals per row (rows 1+); n chains → tiny arrays, linear scan.
  const occupied: { start: number; end: number }[][] = []
  for (const id of others) {
    // Reserve the chain's whole visual footprint: the label pad and the fork
    // lead-in to the left, the merge lead-out to the right (the orthogonal
    // connector runs along the row — see render.ts) — so no other chain on
    // the row ever sits underneath those runs.
    const forkColumn = columnOf.get(span[id].oldest?.parents[0] ?? '')
    const mergeChild = mergeChildOf.get(chains[id].tipHash)
    const mergeColumn = mergeChild ? columnOf.get(mergeChild.hash) : undefined
    const interval = {
      start: Math.min(span[id].start - LABEL_PAD_COLUMNS, forkColumn ?? Number.MAX_SAFE_INTEGER),
      end: Math.max(span[id].end + 1, mergeColumn ?? -1)
    }
    let row = 0
    while (true) {
      const taken = occupied[row]
      if (!taken || !taken.some((t) => interval.start <= t.end && t.start <= interval.end)) {
        ;(occupied[row] ??= []).push(interval)
        rowOfChain.set(id, row + 1)
        break
      }
      row++
    }
  }
  const rowCount = chains.length === 0 ? 0 : occupied.length + 1

  // ── Rows (one per chain), colors, and the sorted output list ──────────────
  const rows: GraphRow[] = chains.map((chain, id) => ({
    index: rowOfChain.get(id) ?? 0,
    name: chain.name,
    kind: chain.kind,
    isHead: false,
    tipHash: chain.tipHash,
    baseHash: span[id].oldest?.parents[0] ?? null,
    color: id === mainChain ? 0 : colorForName(chain.name),
    startColumn: span[id].start,
    endColumn: span[id].end
  }))

  // ── Nodes ──────────────────────────────────────────────────────────────────
  const nodes: GraphNode[] = []
  const nodeByHash = new Map<string, GraphNode>()
  // Kept commits iterated oldest-first so `nodes` comes out column-ascending.
  for (let i = kept.length - 1; i >= 0; i--) {
    const commit = kept[i]
    const chainId = chainOf.get(commit.hash) ?? 0
    const node: GraphNode = {
      commit,
      row: rowOfChain.get(chainId) ?? 0,
      column: columnOf.get(commit.hash) ?? 0,
      color: rows[chainId].color,
      refs: parseRefs(commit.refs),
      isMerge: commit.parents.length > 1,
      isHead: commit.hash === headHash,
      truncated: false
    }
    nodes.push(node)
    nodeByHash.set(commit.hash, node)
    if (node.isHead) rows[chainId].isHead = true
  }

  // ── Edges: child → each in-window parent ──────────────────────────────────
  // With structure-only, a survivor's first parent may be a dropped interior
  // commit — bridge along first parents to the nearest surviving ancestor
  // (always on the same chain, since chain starts survive).
  const resolveParent = (hash: string): string => {
    let p = hash
    while (structural && !structural.has(p)) {
      const c = commitByHash.get(p)
      if (!c || !chainOf.has(p) || c.parents.length === 0) return p
      p = c.parents[0]
    }
    return p
  }
  const edges: GraphEdge[] = []
  for (const node of nodes) {
    node.commit.parents.forEach((parent, parentIdx) => {
      const resolved = resolveParent(parent)
      const target = nodeByHash.get(resolved)
      if (!target) {
        node.truncated = true
        return
      }
      // "line" means same CHAIN (covered by the row spine) — packed rows can
      // host several chains, so a same-row fork must still draw as a fork.
      const sameChain = chainOf.get(node.commit.hash) === chainOf.get(resolved)
      const kind: GraphEdgeKind = parentIdx > 0 ? 'merge' : sameChain ? 'line' : 'fork'
      edges.push({
        kind,
        // Merges carry the source branch's color, forks the new branch's.
        color: kind === 'merge' ? target.color : node.color,
        fromHash: node.commit.hash,
        toHash: resolved,
        fromColumn: node.column,
        fromRow: node.row,
        toColumn: target.column,
        toRow: target.row
      })
    })
  }

  rows.sort((a, b) => a.index - b.index || a.startColumn - b.startColumn)
  return { rows, rowCount, nodes, edges, columnCount: kept.length, nodeByHash, headHash }
}
