import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import {
  CAPSULE_HALF_H,
  CAPTION_FULL_ZOOM,
  CAPTION_GAP_WORLD,
  CAPTION_INK_ABOVE,
  CAPTION_INK_BELOW,
  captionAlpha,
  captionCenterOffset,
  contentSize,
  HEADER_H,
  hitTest,
  LABEL_GAP,
  LABEL_H,
  NODE_R,
  neighborNode,
  nodeX,
  nodeY,
  ROW_H,
  revealRowDy,
  rowEndpoint
} from './geometry'
import { type GraphInput, layoutGraph } from './layout'

function commit(hash: string, parents: string[], refs = ''): Commit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject: `subject ${hash}`,
    body: '',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    date: '2026-07-01T10:00:00+00:00',
    relativeDate: 'now',
    refs,
    parents
  }
}

/** main: a ── b ── m(merge)   feature: f (forked at a, merged at m) */
function sampleLayout() {
  const input: GraphInput = {
    commits: [
      commit('m', ['b', 'f'], 'HEAD -> main'),
      commit('f', ['a'], 'feature'),
      commit('b', ['a']),
      commit('a', [])
    ],
    remotes: [],
    headBranch: 'main',
    detached: false,
    defaultBranch: 'main'
  }
  return layoutGraph(input)
}

describe('graph geometry', () => {
  test('hitTest finds the node under its center and misses empty space', () => {
    const layout = sampleLayout()
    const m = layout.nodeByHash.get('m')
    if (!m) throw new Error('missing node')
    const hit = hitTest(layout, nodeX(m.column), nodeY(m.row), () => 40, null, -1)
    expect(hit?.type).toBe('node')
    if (hit?.type === 'node') expect(hit.node.commit.hash).toBe('m')
    // Below every row, label band and caption band: nothing.
    expect(hitTest(layout, nodeX(m.column), nodeY(1) + 60, () => 40, null, -1)).toBeNull()
  })

  test('a caption band hit resolves to its commit', () => {
    const layout = sampleLayout()
    const m = layout.nodeByHash.get('m')
    if (!m) throw new Error('missing node')
    // Just under the node, where its subject text draws.
    const hit = hitTest(layout, nodeX(m.column) + 4, nodeY(m.row) + 24, () => 40, null, -1)
    expect(hit?.type).toBe('node')
    if (hit?.type === 'node') expect(hit.node.commit.hash).toBe('m')
  })

  test('caption hits follow the drawn glyph width, not the slot estimate', () => {
    const layout = sampleLayout()
    const m = layout.nodeByHash.get('m')
    if (!m) throw new Error('missing node')
    const y = nodeY(m.row) + 24
    const clamp = Number.NEGATIVE_INFINITY
    const at = (x: number, drawnWidth: number) =>
      hitTest(
        layout,
        x,
        y,
        () => 40,
        null,
        -1,
        clamp,
        true,
        () => drawnWidth
      )
    // The renderer culled the caption (drawn width 0): its band no longer hits.
    expect(at(nodeX(m.column) + 4, 0)).toBeNull()
    // Drawn 30 wide: a point over the glyphs hits, the slot's empty tail misses.
    const overGlyphs = at(nodeX(m.column) + 4, 30)
    expect(overGlyphs?.type).toBe('node')
    if (overGlyphs?.type === 'node') expect(overGlyphs.node.commit.hash).toBe('m')
    expect(at(nodeX(m.column) + 40, 30)).toBeNull()
  })

  test('the branch container capsule is a click target between its nodes', () => {
    const layout = sampleLayout()
    // Column 2 on the main row has no node (f sits on the feature row) — the
    // point lands inside main's capsule instead.
    const hit = hitTest(layout, nodeX(2), nodeY(0), () => 40, null, -1)
    expect(hit?.type).toBe('row')
    if (hit?.type === 'row') expect(hit.row.name).toBe('main')
  })

  test('arrow keys walk the row and jump to the column-nearest node across rows', () => {
    const layout = sampleLayout()
    const m = layout.nodeByHash.get('m')
    const b = layout.nodeByHash.get('b')
    const f = layout.nodeByHash.get('f')
    if (!m || !b || !f) throw new Error('missing node')
    expect(neighborNode(layout, m, 'ArrowLeft')?.commit.hash).toBe('b')
    expect(neighborNode(layout, b, 'ArrowRight')?.commit.hash).toBe('m')
    // Up from the feature row lands on the mainline's column-nearest node.
    expect(neighborNode(layout, f, 'ArrowUp')?.commit.hash).toBe('b')
    expect(neighborNode(layout, m, 'ArrowRight')).toBeNull()
  })

  test('the caption hit band sits a world-fixed gap below the capsule', () => {
    const layout = sampleLayout()
    const m = layout.nodeByHash.get('m')
    if (!m) throw new Error('missing node')
    const x = nodeX(m.column) + 4
    const clamp = Number.NEGATIVE_INFINITY
    const at = (wy: number, scale: number) =>
      hitTest(
        layout,
        x,
        wy,
        () => 40,
        null,
        -1,
        clamp,
        true,
        () => 30,
        scale
      )
    // The caption rides a fixed WORLD gap below the capsule (its screen distance
    // scales with zoom), so the SAME world point lands in its band at any zoom.
    const center = captionCenterOffset(1)
    expect(captionCenterOffset(3)).toBeCloseTo(center)
    expect(at(nodeY(m.row) + center, 1)?.type).toBe('node')
    expect(at(nodeY(m.row) + center, 3)?.type).toBe('node')
    // A point up near the capsule edge sits in the gap above the band — no hit.
    expect(at(nodeY(m.row) + CAPSULE_HALF_H + 1, 3)).toBeNull()
  })

  test('the caption keeps a proportional gap, clear of both rails at every zoom', () => {
    // The next row's label band starts this many world px below the row center.
    const railBottom = ROW_H - NODE_R - LABEL_GAP - LABEL_H
    // The caption center sits the fixed WORLD gap below the capsule — the SAME
    // at every zoom, so on screen it scales in proportion with the diagram.
    expect(captionCenterOffset(2)).toBeCloseTo(CAPSULE_HALF_H + CAPTION_GAP_WORLD)
    expect(captionCenterOffset(3)).toBeCloseTo(CAPSULE_HALF_H + CAPTION_GAP_WORLD)
    // At every visible zoom the screen-fixed ink stays clear of both rails: the
    // capsule above and the next row's label band below.
    for (const scale of [0.9, 1, 2, 3]) {
      const offset = captionCenterOffset(scale)
      expect(offset - CAPTION_INK_ABOVE / scale).toBeGreaterThan(CAPSULE_HALF_H)
      expect(offset + CAPTION_INK_BELOW / scale).toBeLessThan(railBottom)
    }
  })

  test('the caption layer is all-or-nothing: full at zoom 1, gone below the fade', () => {
    // By construction the layer is fully on exactly when the tightest slot
    // (adjacent commits) reaches the minimum readable width — at zoom 1.
    expect(CAPTION_FULL_ZOOM).toBe(1)
    expect(captionAlpha(1)).toBe(1)
    expect(captionAlpha(3)).toBe(1)
    // Fades as a whole just below, and is fully hidden past the fade span.
    const mid = captionAlpha(0.925)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(captionAlpha(0.85)).toBe(0)
    expect(captionAlpha(0.2)).toBe(0)
  })

  test('Home/End targets: the oldest and newest commit of a node’s row', () => {
    const layout = sampleLayout()
    const m = layout.nodeByHash.get('m')
    const b = layout.nodeByHash.get('b')
    const f = layout.nodeByHash.get('f')
    if (!m || !b || !f) throw new Error('missing node')
    expect(rowEndpoint(layout, m, 'first').commit.hash).toBe('a')
    expect(rowEndpoint(layout, b, 'last').commit.hash).toBe('m')
    // Alone on its row: both endpoints are the node itself.
    expect(rowEndpoint(layout, f, 'first').commit.hash).toBe('f')
    expect(rowEndpoint(layout, f, 'last').commit.hash).toBe('f')
  })

  test('Home/End stay inside the branch when two chains pack one lane', () => {
    // feat1 (f1–f2) lives early, feat2 (g1–g2) much later — far enough apart
    // that the packer parks both on lane 1. Home/End must walk the BRANCH,
    // never cross into the neighbor chain sharing the lane.
    const input: GraphInput = {
      commits: [
        commit('m', ['j', 'g2'], 'HEAD -> main'),
        commit('g2', ['g1'], 'feat2'),
        commit('g1', ['j']),
        commit('j', ['i']),
        commit('i', ['h']),
        commit('h', ['e']),
        commit('e', ['d']),
        commit('d', ['c']),
        commit('c', ['b', 'f2']),
        commit('f2', ['f1'], 'feat1'),
        commit('f1', ['a']),
        commit('b', ['a']),
        commit('a', [])
      ],
      remotes: [],
      headBranch: 'main',
      detached: false,
      defaultBranch: 'main'
    }
    const layout = layoutGraph(input)
    const f1 = layout.nodeByHash.get('f1')
    const g2 = layout.nodeByHash.get('g2')
    if (!f1 || !g2) throw new Error('missing node')
    // The premise: both feature chains share a packed lane.
    expect(f1.row).toBe(g2.row)
    expect(rowEndpoint(layout, g2, 'first').commit.hash).toBe('g1')
    expect(rowEndpoint(layout, f1, 'last').commit.hash).toBe('f2')
  })

  describe('revealRowDy — keep the clicked row clear of the diff pane', () => {
    // The band row 4 draws (label pill through caption) in world y.
    const row = 4
    const bandTop = nodeY(row) - ROW_H / 2
    const bandBottom = nodeY(row) + ROW_H / 2

    test('no pan while the row is fully visible', () => {
      const view = { x: 0, y: 0, scale: 1 }
      expect(revealRowDy(view, bandBottom + 100, row)).toBe(0)
    })

    test('the pane shrink pans up exactly until the band clears the bottom edge', () => {
      // The viewport bottom cuts the row's band 50px above its bottom — the
      // diff pane just opened over it.
      const view = { x: 0, y: 0, scale: 1 }
      const height = bandBottom - 50
      expect(revealRowDy(view, height, row)).toBe(-50)
      // Idempotent: after the pan the row fits and asks for nothing more.
      expect(revealRowDy({ ...view, y: -50 }, height, row)).toBe(0)
    })

    test('the pan respects the zoom level', () => {
      const view = { x: 0, y: 0, scale: 2 }
      const height = bandBottom * 2 - 30
      expect(revealRowDy(view, height, row)).toBe(-30)
    })

    test('never drags the label band under the date header', () => {
      // A viewport shorter than the row's band: bring it up only until its
      // top reaches the header, accepting a cut bottom over a hidden label.
      const view = { x: 0, y: -bandTop + HEADER_H + 10, scale: 1 }
      const height = HEADER_H + ROW_H / 2
      expect(revealRowDy(view, height, row)).toBe(-10)
    })

    test('a row hidden under the header pans down symmetrically', () => {
      // The band starts 30px above the header strip.
      const view = { x: 0, y: -bandTop + HEADER_H - 30, scale: 1 }
      expect(revealRowDy(view, 10_000, row)).toBe(30)
    })

    test('a row spanning the whole strip stays put', () => {
      // Sticking out both ends: it is as visible as it can get.
      const view = { x: 0, y: -bandTop + HEADER_H - 10, scale: 1 }
      const height = HEADER_H + ROW_H - 30
      expect(revealRowDy(view, height, row)).toBe(0)
    })
  })

  test('contentSize reserves a column for the WIP node', () => {
    const layout = sampleLayout()
    expect(contentSize(layout, layout.columnCount).width - contentSize(layout, null).width).toBe(44)
  })

  test('contentSize covers an empty branch slot past the last commit column', () => {
    // 'fresh' points at the HEAD tip: zero commits, slot right of the tip.
    const layout = layoutGraph({
      commits: [commit('b', ['a'], 'HEAD -> main, fresh'), commit('a', [])],
      remotes: [],
      headBranch: 'main',
      detached: false,
      defaultBranch: 'main'
    })
    const fresh = layout.rows.find((r) => r.name === 'fresh')
    if (!fresh) throw new Error('missing empty row')
    expect(fresh.endColumn).toBe(layout.columnCount)
    // One column wider than the commits alone would need.
    expect(contentSize(layout, null).width).toBe(
      contentSize({ ...layout, rows: layout.rows.filter((r) => r.name === 'main') }, null).width +
        44
    )
  })
})
