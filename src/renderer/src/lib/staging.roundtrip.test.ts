// Round-trips the patches `buildBlockPatch` renders through the real `git`
// binary: the unit tests pin the patch text, these prove git actually accepts
// it and stages exactly the chosen lines. Integration tests against a throwaway
// repo (no mocks), matching the main-process git suite — and the hermetic
// config guard so Windows' `core.autocrlf=true` can't rewrite line endings and
// break the exact-content assertions.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDiffFromFile } from '@pierre/diffs'
import {
  buildBlockPatch,
  type ChangedLine,
  type DisplayMeta,
  listBlockLines,
  listChangeBlocks
} from './staging'

let configHome: string

beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-stage-cfg-'))
  const emptyConfig = join(configHome, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig
})

afterAll(() => {
  rmSync(configHome, { recursive: true, force: true })
  delete process.env.GIT_CONFIG_GLOBAL
  delete process.env.GIT_CONFIG_SYSTEM
})

/**
 * Commit `oldText`, put `newText` in the working tree, then `git apply --cached`
 * the line-level patch for every block with at least one kept line. Returns the
 * staged blob — what the partial commit would capture.
 */
function stageSelected(
  oldText: string,
  newText: string,
  isSelected: (line: ChangedLine) => boolean
): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitgrove-stage-'))
  try {
    const git = (args: string[], input?: string) =>
      execFileSync('git', args, { cwd: dir, input, encoding: 'utf8' })
    git(['init', '-q'])
    git(['config', 'user.email', 't@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(dir, 'f.txt'), oldText)
    git(['add', 'f.txt'])
    git(['commit', '-qm', 'init'])
    writeFileSync(join(dir, 'f.txt'), newText)

    const meta = parseDiffFromFile(
      { name: 'f.txt', contents: oldText },
      { name: 'f.txt', contents: newText }
    ) as unknown as DisplayMeta
    const blocks = listChangeBlocks(meta)
    for (const block of blocks) {
      if (!listBlockLines(block).some(isSelected)) continue
      const patch = buildBlockPatch('f.txt', meta, blocks, block.index, isSelected)
      git(['apply', '--cached', '--whitespace=nowarn', '-'], patch)
    }
    return git(['show', ':f.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ALL = () => true

describe('buildBlockPatch round-trips through git apply --cached', () => {
  test('staging a whole single-line edit captures the new line', () => {
    expect(stageSelected('one\ntwo\nthree\n', 'ONE\ntwo\nthree\n', ALL)).toBe('ONE\ntwo\nthree\n')
  })

  test('keeping an addition but demoting its deletion leaves the old line in place', () => {
    // Stage "+ONE" without "-one": git keeps "one" and inserts "ONE".
    const staged = stageSelected(
      'one\ntwo\nthree\n',
      'ONE\ntwo\nthree\n',
      (l) => l.type === 'change-addition'
    )
    expect(staged).toBe('one\nONE\ntwo\nthree\n')
  })

  test('keeping a deletion but dropping its addition just removes the old line', () => {
    const staged = stageSelected(
      'one\ntwo\nthree\n',
      'ONE\ntwo\nthree\n',
      (l) => l.type === 'change-deletion'
    )
    expect(staged).toBe('two\nthree\n')
  })

  test('a subset of a multi-line replacement stages exactly the chosen lines', () => {
    // Replace x,y with X,Y; stage only the line-2 edit (delete x, add X),
    // demoting y and dropping Y. git stages the patch verbatim.
    const staged = stageSelected('a\nx\ny\nb\n', 'a\nX\nY\nb\n', (l) => l.lineNumber === 2)
    expect(staged).toBe('a\ny\nX\nb\n')
  })

  test('only the selected block of a two-edit file is staged', () => {
    // Two far-apart edits; stage just the first. The second must stay unstaged.
    const oldText = 'one\n2\n3\n4\n5\n6\n7\neight\n'
    const newText = 'ONE\n2\n3\n4\n5\n6\n7\nEIGHT\n'
    const staged = stageSelected(oldText, newText, (l) => l.lineNumber === 1)
    expect(staged).toBe('ONE\n2\n3\n4\n5\n6\n7\neight\n')
  })

  test('a file with no trailing newline stages without error', () => {
    // The "\ No newline at end of file" marker must land so git accepts it.
    expect(stageSelected('a\nb', 'a\nB', ALL)).toBe('a\nB')
  })

  test('adding a final newline (last line gains EOL) round-trips', () => {
    expect(stageSelected('a\nb', 'a\nb\n', ALL)).toBe('a\nb\n')
  })
})
