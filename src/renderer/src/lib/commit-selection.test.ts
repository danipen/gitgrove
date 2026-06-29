import { describe, expect, test } from 'bun:test'
import type { ChangedFile } from '@shared/types'
import { buildCommitSelection, buildStashSelection, type FileSelection } from './commit-selection'

const file = (path: string, status: ChangedFile['status'] = 'modified'): ChangedFile => ({
  path,
  status,
  staged: false
})

const selections = (entries: [string, FileSelection][]) => new Map(entries)

describe('buildCommitSelection', () => {
  test('everything checked → all, with the path list short-circuited', () => {
    const sel = buildCommitSelection([file('a'), file('b')], selections([]))
    expect(sel).toEqual({ all: true, paths: [], patches: [] })
  })

  test('an excluded file drops `all` and is left out of the paths', () => {
    const sel = buildCommitSelection([file('a'), file('b')], selections([['b', 'none']]))
    expect(sel).toEqual({ all: false, paths: ['a'], patches: [] })
  })

  test('a partial file contributes its block patches instead of its path', () => {
    const blocks = new Map([
      [0, { patch: 'patch-block-0', excluded: new Set<string>() }],
      [2, { patch: 'patch-block-2', excluded: new Set(['-9']) }]
    ])
    const sel = buildCommitSelection([file('a'), file('b')], selections([['b', blocks]]))
    expect(sel.all).toBe(false)
    expect(sel.paths).toEqual(['a'])
    expect(sel.patches).toEqual(['patch-block-0', 'patch-block-2'])
  })

  test('conflicted files are never committed and force a path-listed commit', () => {
    const sel = buildCommitSelection([file('a'), file('c', 'conflicted')], selections([]))
    expect(sel).toEqual({ all: false, paths: ['a'], patches: [] })
  })
})

describe('buildStashSelection', () => {
  test('everything checked → all, so the stash runs with no pathspec', () => {
    expect(buildStashSelection([file('a'), file('b')], selections([]))).toEqual({
      all: true,
      paths: ['a', 'b']
    })
  })

  test('partially included files are stashed whole', () => {
    const blocks = new Map([[0, { patch: 'patch', excluded: new Set<string>() }]])
    expect(buildStashSelection([file('a')], selections([['a', blocks]]))).toEqual({
      all: true,
      paths: ['a']
    })
  })

  test('excluded and conflicted files are left out', () => {
    const changes = [file('a'), file('b'), file('c', 'conflicted')]
    expect(buildStashSelection(changes, selections([['b', 'none']]))).toEqual({
      all: false,
      paths: ['a']
    })
  })
})
