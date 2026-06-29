import { describe, expect, test } from 'bun:test'
import {
  blockLineKeys,
  buildBlockPatch,
  buildExcludedDiffCss,
  buildFileSelection,
  type ChangedLine,
  type DisplayMeta,
  lineKey,
  lineOwners,
  listBlockLines,
  listChangeBlocks,
  paintSelection,
  rangeChangedLines
} from './staging'

const EMPTY: ReadonlySet<string> = new Set()

/** 10-line file with two edits close enough that the differ merges the hunk. */
const META: DisplayMeta = {
  deletionLines: ['one\n', 'two\n', 'three\n', 'four\n', 'five\n', 'six\n', 'seven\n', 'eight\n'],
  additionLines: ['ONE\n', 'two\n', 'three\n', 'FOUR\n', 'five\n', 'six\n', 'seven\n', 'eight\n'],
  hunks: [
    {
      deletionStart: 1,
      deletionCount: 7,
      additionStart: 1,
      additionCount: 7,
      hunkContent: [
        { type: 'change', deletions: 1, deletionLineIndex: 0, additions: 1, additionLineIndex: 0 },
        { type: 'context', lines: 2 },
        { type: 'change', deletions: 1, deletionLineIndex: 3, additions: 1, additionLineIndex: 3 },
        { type: 'context', lines: 3 }
      ]
    }
  ]
}

describe('listChangeBlocks', () => {
  test('one hunk with two change blocks yields two selectable blocks', () => {
    const blocks = listChangeBlocks(META)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ index: 0, oldStart: 1, oldLines: 1, newLines: 1 })
    expect(blocks[1]).toMatchObject({ index: 1, oldStart: 4, oldLines: 1, newLines: 1 })
  })

  test('anchors: first block has no context above; second sits on the line above', () => {
    const blocks = listChangeBlocks(META)
    expect(blocks[0].anchor).toEqual({ side: 'additions', lineNumber: 1 })
    expect(blocks[1].anchor).toEqual({ side: 'additions', lineNumber: 3 })
  })

  test('pure deletion block anchors on the old side when at hunk start', () => {
    const meta: DisplayMeta = {
      deletionLines: ['gone\n', 'a\n'],
      additionLines: ['a\n'],
      hunks: [
        {
          deletionStart: 1,
          deletionCount: 2,
          additionStart: 1,
          additionCount: 1,
          hunkContent: [
            {
              type: 'change',
              deletions: 1,
              deletionLineIndex: 0,
              additions: 0,
              additionLineIndex: 0
            },
            { type: 'context', lines: 1 }
          ]
        }
      ]
    }
    expect(listChangeBlocks(meta)[0].anchor).toEqual({ side: 'deletions', lineNumber: 1 })
  })
})

describe('buildBlockPatch', () => {
  const blocks = listChangeBlocks(META)

  test('renders a standalone patch with context clamped before the neighbor block', () => {
    const patch = buildBlockPatch('f.txt', META, blocks, 0)
    expect(patch).toBe(
      [
        'diff --git a/f.txt b/f.txt',
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,3 +1,3 @@',
        '-one',
        '+ONE',
        ' two',
        ' three',
        ''
      ].join('\n')
    )
  })

  test('second block takes leading context only up to the previous block', () => {
    const patch = buildBlockPatch('f.txt', META, blocks, 1)
    expect(patch).toContain('@@ -2,6 +2,6 @@')
    expect(patch).toContain('-four')
    expect(patch).toContain('+FOUR')
    // context never includes the other block's changed lines
    expect(patch).not.toContain('-one')
    expect(patch).not.toContain('+ONE')
    expect(patch).not.toContain(' one')
  })

  test('marks a missing trailing newline on the touched side', () => {
    const meta: DisplayMeta = {
      deletionLines: ['a\n', 'b'],
      additionLines: ['a\n', 'B'],
      hunks: [
        {
          deletionStart: 1,
          deletionCount: 2,
          additionStart: 1,
          additionCount: 2,
          hunkContent: [
            { type: 'context', lines: 1 },
            {
              type: 'change',
              deletions: 1,
              deletionLineIndex: 1,
              additions: 1,
              additionLineIndex: 1
            }
          ]
        }
      ]
    }
    const b = listChangeBlocks(meta)
    const patch = buildBlockPatch('x.txt', meta, b, 0)
    expect(patch).toContain('-b\n\\ No newline at end of file')
    expect(patch).toContain('+B\n\\ No newline at end of file')
  })
})

describe('listBlockLines', () => {
  const blocks = listChangeBlocks(META)

  test('lists a block deletions-first, then additions, by side line number', () => {
    expect(listBlockLines(blocks[0])).toEqual([
      { type: 'change-deletion', lineNumber: 1 },
      { type: 'change-addition', lineNumber: 1 }
    ])
  })

  test('a multi-line block enumerates every changed line on each side', () => {
    const meta: DisplayMeta = {
      deletionLines: ['x\n', 'y\n'],
      additionLines: ['X\n', 'Y\n'],
      hunks: [
        {
          deletionStart: 1,
          deletionCount: 2,
          additionStart: 1,
          additionCount: 2,
          hunkContent: [
            {
              type: 'change',
              deletions: 2,
              deletionLineIndex: 0,
              additions: 2,
              additionLineIndex: 0
            }
          ]
        }
      ]
    }
    expect(listBlockLines(listChangeBlocks(meta)[0])).toEqual([
      { type: 'change-deletion', lineNumber: 1 },
      { type: 'change-deletion', lineNumber: 2 },
      { type: 'change-addition', lineNumber: 1 },
      { type: 'change-addition', lineNumber: 2 }
    ])
  })
})

describe('lineKey', () => {
  test('keys additions and deletions distinctly so old/new numbers never collide', () => {
    expect(lineKey({ type: 'change-addition', lineNumber: 4 })).toBe('+4')
    expect(lineKey({ type: 'change-deletion', lineNumber: 4 })).toBe('-4')
  })
})

describe('buildBlockPatch line-level selection', () => {
  test('an unselected deletion is demoted to a context line', () => {
    // Block 0 of META edits line 1 (delete "one", add "ONE"). Keep the addition
    // but not the deletion: "one" must survive in the index as context.
    const blocks = listChangeBlocks(META)
    const keepAdditions = (l: ChangedLine) => l.type === 'change-addition'
    const patch = buildBlockPatch('f.txt', META, blocks, 0, keepAdditions)
    expect(patch).toContain('@@ -1,3 +1,4 @@')
    expect(patch).toContain(' one') // demoted, not removed
    expect(patch).not.toContain('-one')
    expect(patch).toContain('+ONE')
  })

  test('an unselected addition is dropped entirely', () => {
    const blocks = listChangeBlocks(META)
    const keepDeletions = (l: ChangedLine) => l.type === 'change-deletion'
    const patch = buildBlockPatch('f.txt', META, blocks, 0, keepDeletions)
    expect(patch).toContain('@@ -1,3 +1,2 @@')
    expect(patch).toContain('-one')
    expect(patch).not.toContain('+ONE') // dropped — never enters the patch
  })

  test('selecting a subset of a multi-line block recomputes the header', () => {
    // Replace two lines with two; stage only the first deletion and first
    // addition, demoting the second deletion and dropping the second addition.
    const meta: DisplayMeta = {
      deletionLines: ['a\n', 'x\n', 'y\n', 'b\n'],
      additionLines: ['a\n', 'X\n', 'Y\n', 'b\n'],
      hunks: [
        {
          deletionStart: 1,
          deletionCount: 4,
          additionStart: 1,
          additionCount: 4,
          hunkContent: [
            { type: 'context', lines: 1 },
            {
              type: 'change',
              deletions: 2,
              deletionLineIndex: 1,
              additions: 2,
              additionLineIndex: 1
            },
            { type: 'context', lines: 1 }
          ]
        }
      ]
    }
    const blocks = listChangeBlocks(meta)
    const firstOnly = (l: ChangedLine) => l.lineNumber === 2
    const patch = buildBlockPatch('m.txt', meta, blocks, 0, firstOnly)
    // old: a + 2 deletions + b = 4; new: a + (demoted "y") + selected "X" + b = 4
    expect(patch).toBe(
      [
        'diff --git a/m.txt b/m.txt',
        '--- a/m.txt',
        '+++ b/m.txt',
        '@@ -1,4 +1,4 @@',
        ' a',
        '-x',
        ' y',
        '+X',
        ' b',
        ''
      ].join('\n')
    )
  })

  test('the default predicate reproduces the whole-block patch', () => {
    const blocks = listChangeBlocks(META)
    expect(buildBlockPatch('f.txt', META, blocks, 0, () => true)).toBe(
      buildBlockPatch('f.txt', META, blocks, 0)
    )
  })
})

describe('buildFileSelection', () => {
  const blocks = listChangeBlocks(META) // two blocks: 0 (line 1) and 1 (line 4)

  test('every line of every block included collapses to "all"', () => {
    expect(buildFileSelection('f.txt', META, blocks, () => EMPTY)).toBe('all')
  })

  test('every line excluded collapses to "none"', () => {
    expect(buildFileSelection('f.txt', META, blocks, (i) => blockLineKeys(blocks[i]))).toBe('none')
  })

  test('one block excluded yields a map of just the contributing block', () => {
    const sel = buildFileSelection('f.txt', META, blocks, (i) =>
      i === 1 ? blockLineKeys(blocks[1]) : EMPTY
    )
    if (sel === 'all' || sel === 'none') throw new Error('expected a partial selection')
    expect([...sel.keys()]).toEqual([0])
    expect(sel.get(0)?.excluded.size).toBe(0)
    expect(sel.get(0)?.patch).toContain('-one')
  })

  test('a partially-excluded block keeps its exclusions and a line-subset patch', () => {
    // Exclude the deletion of block 0 ("-one"), keep its addition ("+ONE").
    const excludedKey = lineKey({ type: 'change-deletion', lineNumber: 1 })
    const sel = buildFileSelection('f.txt', META, blocks, (i) =>
      i === 0 ? new Set([excludedKey]) : EMPTY
    )
    if (sel === 'all' || sel === 'none') throw new Error('expected a partial selection')
    expect(sel.get(0)?.excluded).toEqual(new Set([excludedKey]))
    expect(sel.get(0)?.patch).toContain(' one') // demoted to context
    expect(sel.get(0)?.patch).not.toContain('-one')
  })
})

describe('buildExcludedDiffCss', () => {
  test('returns empty string when nothing is excluded', () => {
    expect(buildExcludedDiffCss([])).toBe('')
  })

  test('keys each excluded line by number, scoped to its side', () => {
    const css = buildExcludedDiffCss([
      { type: 'change-addition', lineNumber: 4 },
      { type: 'change-deletion', lineNumber: 4 }
    ])
    expect(css).toContain(
      '[data-line-type="change-addition"]:is([data-line="4"],[data-column-number="4"])'
    )
    expect(css).toContain(
      '[data-line-type="change-deletion"]:is([data-line="4"],[data-column-number="4"])'
    )
    // Excluded lines take the unselected bar's flat gray (--bg-panel).
    expect(css).toContain('background-color:var(--bg-panel)')
  })

  test('grays exactly the lines passed — a single excluded line within a block', () => {
    const css = buildExcludedDiffCss([{ type: 'change-addition', lineNumber: 2 }])
    expect(css).toContain(
      '[data-line-type="change-addition"]:is([data-line="2"],[data-column-number="2"])'
    )
    expect(css).not.toContain('[data-line="1"]')
    expect(css).not.toContain('change-deletion')
  })
})

describe('lineOwners', () => {
  test('maps each changed line key to its owning block', () => {
    const blocks = listChangeBlocks(META) // block 0 (line 1), block 1 (line 4)
    const owner = lineOwners(blocks)
    expect(owner.get(lineKey({ type: 'change-deletion', lineNumber: 1 }))).toBe(0)
    expect(owner.get(lineKey({ type: 'change-addition', lineNumber: 1 }))).toBe(0)
    expect(owner.get(lineKey({ type: 'change-deletion', lineNumber: 4 }))).toBe(1)
    expect(owner.get(lineKey({ type: 'change-addition', lineNumber: 4 }))).toBe(1)
  })
})

// A single change block of three added lines (new lines 2, 3, 4), so a stroke
// can cover a run *within* one block.
const ADD3: DisplayMeta = {
  deletionLines: ['a\n', 'b\n'],
  additionLines: ['a\n', 'x\n', 'y\n', 'z\n', 'b\n'],
  hunks: [
    {
      deletionStart: 1,
      deletionCount: 2,
      additionStart: 1,
      additionCount: 5,
      hunkContent: [
        { type: 'context', lines: 1 },
        { type: 'change', deletions: 0, deletionLineIndex: 1, additions: 3, additionLineIndex: 1 },
        { type: 'context', lines: 1 }
      ]
    }
  ]
}
const add = (lineNumber: number): ChangedLine => ({ type: 'change-addition', lineNumber })
const del = (lineNumber: number): ChangedLine => ({ type: 'change-deletion', lineNumber })

describe('rangeChangedLines', () => {
  test('covers the inclusive run between anchor and pointer', () => {
    const blocks = listChangeBlocks(ADD3)
    expect(rangeChangedLines(blocks, true, add(2), add(4))).toEqual([add(2), add(3), add(4)])
  })

  test('is the same run regardless of drag direction', () => {
    const blocks = listChangeBlocks(ADD3)
    expect(rangeChangedLines(blocks, true, add(4), add(2))).toEqual([add(2), add(3), add(4)])
  })

  test('dragging back toward the anchor shrinks the run (overshoot self-corrects)', () => {
    const blocks = listChangeBlocks(ADD3)
    expect(rangeChangedLines(blocks, true, add(2), add(3))).toEqual([add(2), add(3)])
  })

  test('unified order interleaves a block — anchoring on an addition can reach a deletion', () => {
    // META rows in unified order: -1, +1, -4, +4.
    const blocks = listChangeBlocks(META)
    expect(rangeChangedLines(blocks, true, add(1), add(4))).toEqual([add(1), del(4), add(4)])
  })

  test('split keeps the run on the anchor side, skipping the other column', () => {
    const blocks = listChangeBlocks(META)
    expect(rangeChangedLines(blocks, false, add(1), add(4))).toEqual([add(1), add(4)])
  })

  test('returns [] when the pointer is off the anchor track (other split column)', () => {
    const blocks = listChangeBlocks(META)
    expect(rangeChangedLines(blocks, false, add(1), del(4))).toEqual([])
  })
})

describe('paintSelection', () => {
  const allIn = (): ReadonlySet<string> => EMPTY

  test('painting a run to "exclude" leaves exactly those lines out of the commit', () => {
    const blocks = listChangeBlocks(ADD3)
    const owner = lineOwners(blocks)
    const sel = paintSelection('f.txt', ADD3, blocks, owner, allIn, [add(2), add(3)], true)
    if (sel === 'all' || sel === 'none') throw new Error('expected a partial selection')
    expect(sel.get(0)?.excluded).toEqual(new Set([lineKey(add(2)), lineKey(add(3))]))
  })

  test('painting every line of the only block out collapses to "none"', () => {
    const blocks = listChangeBlocks(ADD3)
    const owner = lineOwners(blocks)
    expect(
      paintSelection('f.txt', ADD3, blocks, owner, allIn, listBlockLines(blocks[0]), true)
    ).toBe('none')
  })

  test('painting to "include" from an all-excluded base puts the lines back in', () => {
    const blocks = listChangeBlocks(META)
    const owner = lineOwners(blocks)
    const allOut = (i: number) => blockLineKeys(blocks[i])
    const sel = paintSelection(
      'f.txt',
      META,
      blocks,
      owner,
      allOut,
      listBlockLines(blocks[0]),
      false
    )
    if (sel === 'all' || sel === 'none') throw new Error('expected a partial selection')
    expect([...sel.keys()]).toEqual([0])
    expect(sel.get(0)?.excluded.size).toBe(0)
  })

  test('a painted run flows across blocks', () => {
    const blocks = listChangeBlocks(META)
    const owner = lineOwners(blocks)
    const sel = paintSelection('f.txt', META, blocks, owner, allIn, [add(1), add(4)], true)
    if (sel === 'all' || sel === 'none') throw new Error('expected a partial selection')
    expect(sel.get(0)?.excluded.has(lineKey(add(1)))).toBe(true)
    expect(sel.get(1)?.excluded.has(lineKey(add(4)))).toBe(true)
  })
})

describe('drag stroke (range + paint composed)', () => {
  // Replay a stroke: paint the anchor→pointer range, fresh from the base, on each
  // move — exactly what the gutter drag does, so the overshoot behaviour is the
  // emergent result, not special-cased.
  const replay = (meta: DisplayMeta, anchor: ChangedLine, moves: ChangedLine[]) => {
    const blocks = listChangeBlocks(meta)
    const owner = lineOwners(blocks)
    const base = (): ReadonlySet<string> => EMPTY // everything starts included
    let sel: ReturnType<typeof paintSelection> = 'all'
    for (const cur of [anchor, ...moves]) {
      const range = rangeChangedLines(blocks, true, anchor, cur)
      sel = paintSelection('f.txt', meta, blocks, owner, base, range, true)
    }
    return sel
  }

  test('sweeping down a block excludes the whole run', () => {
    expect(replay(ADD3, add(2), [add(3), add(4)])).toBe('none')
  })

  test('overshooting then dragging back leaves only the run up to the release point', () => {
    // Down to 4, then back to 3: the final range is 2..3, so 4 is never excluded.
    const sel = replay(ADD3, add(2), [add(3), add(4), add(3)])
    if (sel === 'all' || sel === 'none') throw new Error('expected a partial selection')
    expect(sel.get(0)?.excluded).toEqual(new Set([lineKey(add(2)), lineKey(add(3))]))
  })
})
