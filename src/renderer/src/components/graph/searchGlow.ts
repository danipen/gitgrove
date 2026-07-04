// Pure logic behind the Graph search highlight — the text-editor find pattern
// translated to canvas: every hit glows warm gold, the CURRENT hit wears a
// wider corona and lands with a brief sonar ping. Kept free of canvas types
// so the geometry and color math are directly testable.

/** How far past the node radius a hit's glow fades to nothing (world px). */
export const HIT_GLOW = 9
/** The current hit's corona reaches further — "you are here" among hits. */
export const ACTIVE_GLOW = 16

/** Duration of the arrival ping (ms) — GraphCanvas drives pulse 0→1 over it. */
export const PING_MS = 650
/** How far the ping travels past its start radius (world px). */
const PING_SPAN = 20
/** The second ring launches when the first is 35% out — a sonar double-tap. */
const PING_STAGGER = 0.35

/** One expanding ring of the arrival ping. */
export interface PingRing {
  /** World px the ring has grown past its start radius. */
  grow: number
  alpha: number
  width: number
}

/** The arrival ping at `pulse` (0 = just landed … 1 = settled): two staggered
 *  rings that expand while fading with an ease-out square — fast birth, soft
 *  death. Returns [] once settled, so the steady state draws nothing extra. */
export function pingRings(pulse: number): PingRing[] {
  if (pulse < 0 || pulse >= 1) return []
  const rings: PingRing[] = []
  for (const start of [0, PING_STAGGER]) {
    const p = (pulse - start) / (1 - start)
    if (p <= 0 || p >= 1) continue
    const fade = (1 - p) ** 2
    rings.push({ grow: p * PING_SPAN, alpha: fade * 0.7, width: 0.5 + 1.5 * fade })
  }
  return rings
}

// Alpha'd colors are built per (color, alpha) once — the draw loop asks for
// the same handful every frame.
const alphaCache = new Map<string, string>()

/** `color` (a #rgb/#rrggbb design token) with `alpha` applied. Radial glows
 *  need per-stop alpha and canvas gradient stops take color strings only, so
 *  alpha is injected into the token here. Unknown formats pass through
 *  (opaque) rather than break the draw. */
export function withAlpha(color: string, alpha: number): string {
  const key = `${color}/${alpha}`
  let value = alphaCache.get(key)
  if (value) return value
  const hex = color.startsWith('#') ? color.slice(1) : null
  if (hex && (hex.length === 3 || hex.length === 6)) {
    const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex
    const n = Number.parseInt(full, 16)
    if (!Number.isNaN(n)) {
      value = `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`
    }
  }
  value ??= color
  alphaCache.set(key, value)
  return value
}

/** A search result: a commit, a branch LABEL, or a tag chip. Searching a
 *  branch or tag name finds the ref itself — its pill/chip glows and is what
 *  Enter steps to — never the commit it happens to decorate. */
export type SearchHit =
  | { kind: 'commit'; hash: string }
  | { kind: 'branch'; chain: number }
  | { kind: 'tag'; hash: string }

interface SearchableNode {
  commit: { hash: string; subject: string; authorName: string; authorEmail: string }
  refs: readonly { name: string; isTag: boolean }[]
  column: number
  row: number
}

interface SearchableRow {
  chain: number
  name: string
  index: number
  startColumn: number
}

/** All search results, ordered newest-first (descending column — the order
 *  Enter steps through). The author filter gates commits only: branches and
 *  tags have no author. With no terms it degrades to the author filter's
 *  commit set, which feeds dimming while the search box is empty. */
export function computeSearchHits(
  terms: readonly string[],
  authorFilter: ReadonlySet<string> | null,
  nodes: readonly SearchableNode[],
  rows: readonly SearchableRow[]
): SearchHit[] {
  if (terms.length === 0 && authorFilter === null) return []
  const matchesTerms = (hay: string) => terms.every((t) => hay.includes(t))
  const entries: { hit: SearchHit; column: number; order: number }[] = []
  for (const node of nodes) {
    const c = node.commit
    const byAuthor = authorFilter === null || authorFilter.has(c.authorEmail.toLowerCase())
    if (byAuthor && matchesTerms(`${c.subject} ${c.authorName} ${c.hash}`.toLowerCase())) {
      entries.push({ hit: { kind: 'commit', hash: c.hash }, column: node.column, order: node.row })
    }
    // One tag hit per COMMIT, not per tag: all its tags render as one chip,
    // and one chip on screen must be one stop when stepping.
    if (terms.length > 0 && node.refs.some((r) => r.isTag && matchesTerms(r.name.toLowerCase()))) {
      entries.push({
        hit: { kind: 'tag', hash: c.hash },
        column: node.column,
        // The chip sits above its node — visit it just before the commit.
        order: node.row - 0.5
      })
    }
  }
  if (terms.length > 0) {
    for (const row of rows) {
      if (matchesTerms(row.name.toLowerCase())) {
        entries.push({
          hit: { kind: 'branch', chain: row.chain },
          column: row.startColumn,
          order: row.index - 0.5
        })
      }
    }
  }
  entries.sort((a, b) => b.column - a.column || a.order - b.order)
  return entries.map((e) => e.hit)
}

/** Stable identity for a hit: effects key off it so the arrival ping re-fires
 *  only when the TARGET changes, not when the hits array is rebuilt. */
export function hitKey(hit: SearchHit | null): string | null {
  if (hit === null) return null
  return hit.kind === 'branch' ? `branch:${hit.chain}` : `${hit.kind}:${hit.hash}`
}

/** The chains (GraphRow.chain / GraphNode.chain) holding at least one match.
 *  Branch labels of chains with none ghost alongside their dimmed commits —
 *  a lit label over dimmed commits would claim a hit the branch doesn't have. */
export function litChains(
  nodes: readonly { chain: number; commit: { hash: string } }[],
  matches: ReadonlySet<string>,
  /** Chains lit regardless of their commits — a branch-label hit stays at
   *  full strength even though none of its commits matched. */
  extra: ReadonlySet<number> | null = null
): ReadonlySet<number> {
  const lit = new Set<number>(extra ?? [])
  for (const node of nodes) {
    if (matches.has(node.commit.hash)) lit.add(node.chain)
  }
  return lit
}
