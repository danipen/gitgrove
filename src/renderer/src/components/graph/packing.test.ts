import { describe, expect, test } from 'bun:test'
import { type PackChain, packRows } from './packing'

const MAIN = 0

/** A chain hanging off the mainline unless overridden. Defaults make the
 *  whole footprint capsule with a minimal pill, so interval tests read
 *  plainly. */
function chain(id: number, overrides: Partial<PackChain> = {}): PackChain {
  const start = overrides.start ?? 0
  const end = overrides.end ?? 0
  return {
    id,
    start,
    end,
    capStart: start,
    capEnd: end,
    labelEnd: overrides.capStart ?? start,
    parent: MAIN,
    releaseRank: null,
    isHead: false,
    stubs: [],
    ...overrides
  }
}

describe('packRows', () => {
  test('the mainline is seeded on row 0 and everything packs below it', () => {
    const rows = packRows([chain(1, { start: 0, end: 5 })], MAIN)
    expect(rows.get(MAIN)).toBe(0)
    expect(rows.get(1)).toBe(1)
  })

  test('non-overlapping chains share a row (density before everything)', () => {
    const rows = packRows(
      [chain(1, { start: 0, end: 5 }), chain(2, { start: 7, end: 12 })],
      MAIN
    )
    expect(rows.get(1)).toBe(1)
    expect(rows.get(2)).toBe(1)
  })

  test('overlapping chains stack on separate rows', () => {
    const rows = packRows(
      [chain(1, { start: 0, end: 5 }), chain(2, { start: 3, end: 12 })],
      MAIN
    )
    expect(rows.get(1)).not.toBe(rows.get(2))
  })

  test('nested lifetimes pack inner-above-outer, ordered by merge column', () => {
    // Outer forked first but merges LAST (end 20); inner lives entirely
    // inside its span. Fork-order packing would put outer on row 1 and slice
    // inner's connectors through it — merge-column order nests them cleanly.
    const outer = chain(1, { start: 0, end: 20, stubs: [{ column: 0, other: MAIN }] })
    const inner = chain(2, { start: 5, end: 12, stubs: [{ column: 12, other: MAIN }] })
    const rows = packRows([outer, inner], MAIN)
    expect(rows.get(2)).toBe(1)
    expect(rows.get(1)).toBe(2)
  })

  test('a backport drifts down to hug the release line it merges into', () => {
    // Rows 1 and 3 both have room, but the chain merges into the release
    // line on row 3: parked on row 1 its merge connector would drop across
    // row 2's capsule; drifting to the target's own row crosses nothing.
    const rows = packRows(
      [
        chain(1, { start: 0, end: 15, releaseRank: 0 }),
        chain(2, { start: 0, end: 50, releaseRank: 1 }),
        chain(3, { start: 0, end: 15, releaseRank: 2 }),
        chain(4, { start: 20, end: 30, stubs: [{ column: 30, other: 3 }] })
      ],
      MAIN
    )
    expect(rows.get(3)).toBe(3)
    expect(rows.get(4)).toBe(3)
    // Sanity: without the merge connector, the same chain takes row 1.
    const calm = packRows(
      [
        chain(1, { start: 0, end: 15, releaseRank: 0 }),
        chain(2, { start: 0, end: 50, releaseRank: 1 }),
        chain(3, { start: 0, end: 15, releaseRank: 2 }),
        chain(4, { start: 20, end: 30 })
      ],
      MAIN
    )
    expect(calm.get(4)).toBe(1)
  })

  test('clarity never opens a new row while an existing row fits', () => {
    // b's merge lead-out drops through row 1's open stretch. c fits only
    // that stretch among the existing rows — a fresh row below would dodge
    // the crossing, but density wins: the diagram must not grow taller.
    const rows = packRows(
      [
        chain(1, { start: 0, end: 6 }),
        chain(2, { start: 0, end: 9, stubs: [{ column: 9, other: MAIN }] }),
        chain(3, { start: 8, end: 20 })
      ],
      MAIN
    )
    expect(rows.get(3)).toBe(1)
  })

  test("a long pill may hang over a neighbor's connector runs (shares the row)", () => {
    // a is a 1-commit branch whose pill reaches column 12, over b's fork
    // lead-in (10–15). Pills mask connector lines (opaque base), so the row
    // is shared — a whole-interval rule would cost one of them a row.
    const a = chain(1, { start: 0, end: 4, capStart: 0, capEnd: 3, labelEnd: 12 })
    const b = chain(2, { start: 10, end: 21, capStart: 16, capEnd: 20, labelEnd: 19 })
    const rows = packRows([a, b], MAIN)
    expect(rows.get(1)).toBe(1)
    expect(rows.get(2)).toBe(1)
  })

  test("a pill never reaches a neighbor's label anchor or commits", () => {
    // a's pill reaches column 15 — past b's first commit (14), where b's own
    // pill anchors. Overlapping pills (or a pill over commits) hide ink, so
    // they must not share the row.
    const a = chain(1, { start: 0, end: 4, capStart: 0, capEnd: 3, labelEnd: 15 })
    const b = chain(2, { start: 12, end: 21, capStart: 14, capEnd: 20, labelEnd: 18 })
    const rows = packRows([a, b], MAIN)
    expect(rows.get(1)).not.toBe(rows.get(2))
  })

  test("a merge lead-out never runs under a neighbor's capsule", () => {
    // a's lead-out (11–15) would pass beneath b's commits starting at 12.
    const a = chain(1, { start: 0, end: 15, capStart: 0, capEnd: 10 })
    const b = chain(2, { start: 12, end: 21, capStart: 12, capEnd: 20 })
    const rows = packRows([a, b], MAIN)
    expect(rows.get(1)).not.toBe(rows.get(2))
  })

  test('release lines keep the spine stack: first-fit by rank, no drift', () => {
    // Both releases overlap a vertical-riddled row 1 zone; they must still
    // stack in version order right under the mainline.
    const noisy = chain(3, {
      start: 30,
      end: 40,
      stubs: [{ column: 35, other: MAIN }]
    })
    const rows = packRows(
      [
        noisy,
        chain(1, { start: 0, end: 50, releaseRank: 0 }),
        chain(2, { start: 0, end: 50, releaseRank: 1 })
      ],
      MAIN
    )
    expect(rows.get(1)).toBe(1)
    expect(rows.get(2)).toBe(2)
  })

  test('a child never packs above its parent, whatever the cost says', () => {
    const parent = chain(1, { start: 0, end: 10 })
    const child = chain(2, { start: 30, end: 40, parent: 1 })
    const rows = packRows([parent, child], MAIN)
    expect(rows.get(2)).toBe((rows.get(1) ?? 0) + 1)
  })

  test('HEAD packs first within its depth', () => {
    // Both want row 1 and overlap; HEAD wins it despite merging later.
    const other = chain(1, { start: 0, end: 5 })
    const head = chain(2, { start: 3, end: 12, isHead: true })
    const rows = packRows([other, head], MAIN)
    expect(rows.get(2)).toBe(1)
    expect(rows.get(1)).toBe(2)
  })

  test('no mainline (-1) still packs from row 1', () => {
    const rows = packRows([chain(1, { parent: null, start: 0, end: 3 })], -1)
    expect(rows.get(1)).toBe(1)
  })
})
