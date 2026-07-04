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

/** The chains (GraphRow.chain / GraphNode.chain) holding at least one match.
 *  Branch labels of chains with none ghost alongside their dimmed commits —
 *  a lit label over dimmed commits would claim a hit the branch doesn't have. */
export function litChains(
  nodes: readonly { chain: number; commit: { hash: string } }[],
  matches: ReadonlySet<string>
): ReadonlySet<number> {
  const lit = new Set<number>()
  for (const node of nodes) {
    if (matches.has(node.commit.hash)) lit.add(node.chain)
  }
  return lit
}
