import { describe, expect, test } from 'bun:test'
import type { Commit } from '@shared/types'
import { contentSize, hitTest, neighborNode, nodeX, nodeY } from './geometry'
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

  test('contentSize reserves a column for the WIP node', () => {
    const layout = sampleLayout()
    expect(contentSize(layout, true).width - contentSize(layout, false).width).toBe(44)
  })
})
