// Selection-to-patch plumbing for the working diff.
//
// Checkboxes are pure renderer state — "include this in the next commit" —
// and git is only touched at commit time. Selection works at two grains: the
// *change block* (each contiguous run of added/removed lines gets a checkbox,
// even when the display differ merges nearby blocks into one hunk — it joins
// changes closer than ~2× the context size), and the individual *line* within
// it. Either way a contributing block is rendered back into a standalone
// unified patch: apply it to a HEAD-equal index with `git apply --cached` to
// include it in a commit, or reverse-apply it to the working tree to discard
// it.
//
// Pure functions over the metadata shape @pierre/diffs produces; unit-tested
// and round-tripped through real `git apply`.

import type { BlockSelection, FileSelection } from './commit-selection'

/**
 * The structural subset of @pierre/diffs' FileDiffMetadata we read. Declared
 * locally so this module (and its tests) stay dependency-free.
 */
export interface DisplayHunk {
  additionStart: number
  additionCount: number
  deletionStart: number
  deletionCount: number
  hunkContent: (
    | { type: 'context'; lines: number }
    | {
        type: 'change'
        deletions: number
        deletionLineIndex: number
        additions: number
        additionLineIndex: number
      }
  )[]
}

/** Full-contents line arrays of the displayed diff (isPartial === false). */
export interface DisplayMeta {
  deletionLines: string[]
  additionLines: string[]
  hunks: DisplayHunk[]
}

/** One contiguous run of changed lines — the coarse unit of commit selection. */
export interface ChangeBlock {
  /** Ordinal across the whole file: the selection/annotation key. */
  index: number
  /** First old-side line of the block (insertion point for pure additions). */
  oldStart: number
  /** Removed line count (the block's `deletions` stat). */
  oldLines: number
  /** First new-side line of the block. */
  newStart: number
  /** Added line count (the block's `additions` stat). */
  newLines: number
  /** Where the block's selection bar anchors in the rendered diff. */
  anchor: { side: 'additions' | 'deletions'; lineNumber: number }
}

/**
 * A single changed line on its own side — the *fine* unit of commit selection.
 * `type` mirrors the `data-line-type` @pierre/diffs emits, so the same value
 * keys both the patch math and the CSS that grays excluded lines. `lineNumber`
 * is the line's number on its own side (old for deletions, new for additions).
 */
export interface ChangedLine {
  type: 'change-addition' | 'change-deletion'
  lineNumber: number
}

/** Stable, compact key for a changed line (`+34` / `-12`) — the selection id. */
export const lineKey = ({ type, lineNumber }: ChangedLine): string =>
  `${type === 'change-addition' ? '+' : '-'}${lineNumber}`

/** The selection keys of every changed line in a block. */
export const blockLineKeys = (block: ChangeBlock): Set<string> =>
  new Set(listBlockLines(block).map(lineKey))

/**
 * Map every changed line's key to the index of the block that owns it. The
 * renderer uses it to resolve a gutter click — or a drag-paint stroke — back to
 * the block whose exclusions it edits.
 */
export function lineOwners(blocks: readonly ChangeBlock[]): Map<string, number> {
  const owner = new Map<string, number>()
  for (const block of blocks)
    for (const line of listBlockLines(block)) owner.set(lineKey(line), block.index)
  return owner
}

const EMPTY_KEYS: ReadonlySet<string> = new Set()

/**
 * The changed-line keys a block currently leaves *out* of the commit: none when
 * the file is fully in, all of them when it's fully out or the block is absent
 * from a partial map, else the block's stored exclusions.
 */
export function excludedKeysFor(
  selection: FileSelection,
  blocks: ChangeBlock[],
  blockIndex: number
): ReadonlySet<string> {
  if (selection === 'all') return EMPTY_KEYS
  if (selection === 'none') return blockLineKeys(blocks[blockIndex])
  return selection.get(blockIndex)?.excluded ?? blockLineKeys(blocks[blockIndex])
}

/**
 * Every changed line of a block, in unified-patch order: deletions (old side)
 * first, then additions (new side). The renderer iterates these to draw a
 * checkbox per line and to roll the line selection up into the block's state.
 */
export function listBlockLines(block: ChangeBlock): ChangedLine[] {
  const lines: ChangedLine[] = []
  for (let i = 0; i < block.oldLines; i++)
    lines.push({ type: 'change-deletion', lineNumber: block.oldStart + i })
  for (let i = 0; i < block.newLines; i++)
    lines.push({ type: 'change-addition', lineNumber: block.newStart + i })
  return lines
}

const NO_NEWLINE = '\\ No newline at end of file'

/**
 * @pierre/diffs keeps each line's trailing newline in its content arrays
 * (except a file's last line when the file has none — which is how we detect
 * it). Patch lines must not carry the newline; the joiner adds it. Only the
 * final `\n` is stripped — a `\r` from CRLF files stays, as git expects.
 */
const chomp = (line: string | undefined) => (line ?? '').replace(/\n$/, '')

const lacksFinalNewline = (lines: string[]) =>
  lines.length > 0 && !(lines[lines.length - 1] ?? '').endsWith('\n')

/** Enumerate every change block of the displayed diff, in display order. */
export function listChangeBlocks(meta: DisplayMeta): ChangeBlock[] {
  const blocks: ChangeBlock[] = []
  for (const hunk of meta.hunks) {
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    let contextAbove = false
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') {
        oldLine += part.lines
        newLine += part.lines
        contextAbove = part.lines > 0
        continue
      }
      // The bar sits on the rendered line just above the block when the hunk
      // shows one; otherwise on the block's first changed line (old side for
      // pure deletions — the new side has no line there).
      const anchor: ChangeBlock['anchor'] = contextAbove
        ? { side: 'additions', lineNumber: newLine - 1 }
        : part.additions > 0
          ? { side: 'additions', lineNumber: newLine }
          : { side: 'deletions', lineNumber: oldLine }
      blocks.push({
        index: blocks.length,
        oldStart: oldLine,
        oldLines: part.deletions,
        newStart: newLine,
        newLines: part.additions,
        anchor
      })
      oldLine += part.deletions
      newLine += part.additions
      contextAbove = false
    }
  }
  return blocks
}

/** Context lines included around a block patch (matches git's default). */
const BLOCK_CONTEXT = 3

/**
 * Render one change block into a standalone unified patch for `path`, including
 * only the lines `isSelected` keeps. Old-side coordinates are HEAD's, new-side
 * are the working tree's — exactly what `git apply --cached` needs after the
 * index was reset to HEAD, and what `git apply --reverse` needs against the
 * working tree. Context never crosses into a neighboring block (those lines
 * differ between the two sides).
 *
 * Line-level selection follows git's own partial-staging rule (the one
 * `git add -p` builds by hand):
 * - a **selected** deletion/addition is emitted as-is (`-`/`+`);
 * - an **unselected addition** is *dropped* — the patch pretends it was never
 *   written, so it stays only in the working tree;
 * - an **unselected deletion** is *demoted to context* (` `) — the patch
 *   pretends it never happened, so the line survives in the index.
 * The hunk header counts are recomputed from what actually survives. With the
 * default predicate (everything selected) this reduces to a plain block patch.
 */
export function buildBlockPatch(
  path: string,
  meta: DisplayMeta,
  blocks: ChangeBlock[],
  index: number,
  isSelected: (line: ChangedLine) => boolean = () => true
): string {
  const block = blocks[index]
  const prevOldEnd = index > 0 ? blocks[index - 1].oldStart + blocks[index - 1].oldLines : 1
  const nextOldStart = blocks[index + 1]?.oldStart ?? meta.deletionLines.length + 1
  const lead = Math.min(BLOCK_CONTEXT, block.oldStart - prevOldEnd)
  const trail = Math.min(BLOCK_CONTEXT, nextOldStart - (block.oldStart + block.oldLines))

  const oldStart = block.oldStart - lead
  const newStart = block.newStart - lead

  const oldLast = meta.deletionLines.length
  const newLast = meta.additionLines.length
  const oldNoEOF = lacksFinalNewline(meta.deletionLines)
  const newNoEOF = lacksFinalNewline(meta.additionLines)

  // Counts grow with the lines we actually emit, so a partial selection lands a
  // correct `@@` header without separate bookkeeping for each line type.
  const body: string[] = []
  let oldCount = 0
  let newCount = 0

  // Context lines are identical on both sides; read them from the old side and
  // mark a missing trailing newline when the context line ends a side.
  const pushContext = (oldLine: number, newLine: number) => {
    body.push(` ${chomp(meta.deletionLines[oldLine - 1])}`)
    oldCount++
    newCount++
    if ((oldNoEOF && oldLine === oldLast) || (newNoEOF && newLine === newLast))
      body.push(NO_NEWLINE)
  }

  for (let i = 0; i < lead; i++) pushContext(oldStart + i, newStart + i)
  for (let i = 0; i < block.oldLines; i++) {
    const lineNumber = block.oldStart + i
    const text = chomp(meta.deletionLines[lineNumber - 1])
    if (isSelected({ type: 'change-deletion', lineNumber })) {
      body.push(`-${text}`)
      oldCount++
    } else {
      // Unselected deletion: keep the line as context so the index still has it.
      body.push(` ${text}`)
      oldCount++
      newCount++
    }
    if (oldNoEOF && lineNumber === oldLast) body.push(NO_NEWLINE)
  }
  for (let i = 0; i < block.newLines; i++) {
    const lineNumber = block.newStart + i
    // Unselected addition: drop it entirely — it never enters this patch.
    if (!isSelected({ type: 'change-addition', lineNumber })) continue
    body.push(`+${chomp(meta.additionLines[lineNumber - 1])}`)
    newCount++
    if (newNoEOF && lineNumber === newLast) body.push(NO_NEWLINE)
  }
  for (let i = 0; i < trail; i++) {
    pushContext(block.oldStart + block.oldLines + i, block.newStart + block.newLines + i)
  }

  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...body
  ]
  return `${lines.join('\n')}\n`
}

/**
 * CSS for @pierre/diffs' `unsafeCSS` option that repaints the changed lines of
 * *excluded* blocks (checkbox off) with the **same flat gray as the unselected
 * "Include in commit" bar** (`--bg-panel`) — so the block and its header read as
 * one set-aside unit, still clearly a change but visibly not going into the
 * commit. Pierre paints line backgrounds in its shadow DOM, so we feed the rule
 * through `unsafeCSS`; it lands in pierre's last cascade layer (`@layer unsafe`),
 * so a plain `background-color` wins over the diff's green/red without any
 * specificity tricks. The word-level emphasis and the changed line numbers are
 * neutralized to the same gray/muted tone so nothing stays tinted.
 *
 * Each changed line is keyed by its line number on its own side, scoped to the
 * line type so old/new numbers never collide; both the content row
 * (`[data-line]`) and its gutter number cell (`[data-column-number]`) are grayed.
 * Returns '' when nothing is excluded, so the common "all included" case injects
 * no styles at all. The caller passes the exact lines to gray, so this works the
 * same whether a whole block or a few of its lines are left out of the commit.
 */
export function buildExcludedDiffCss(lines: readonly ChangedLine[]): string {
  if (lines.length === 0) return ''
  const selectors = lines.map(
    ({ type, lineNumber }) =>
      `[data-line-type="${type}"]:is([data-line="${lineNumber}"],[data-column-number="${lineNumber}"])`
  )
  // The gutter cells of the same excluded lines: drop their "included" check (it
  // rides the cell's ::after), so a missing tick reads as "left out — click the
  // number to put it back".
  const numbers = lines.map(
    ({ type, lineNumber }) => `[data-line-type="${type}"][data-column-number="${lineNumber}"]`
  )
  return (
    `:is(${selectors.join(',')}){` +
    'background-color:var(--bg-panel);' +
    '--diffs-bg-addition-emphasis-override:var(--bg-panel);' +
    '--diffs-bg-deletion-emphasis-override:var(--bg-panel);' +
    '--diffs-fg-number-addition-override:var(--fg-muted);' +
    '--diffs-fg-number-deletion-override:var(--fg-muted)}' +
    `:is(${numbers.join(',')})::after{display:none}` +
    // Hover an excluded line's number rect: strong gray, not the add/del color.
    `:is(${numbers.join(',')})[data-hovered]{background:var(--bg-active)}`
  )
}

/**
 * Normalize a working file's per-block exclusions into the `FileSelection` the
 * commit model stores. `excludedFor` returns the line keys left out of each
 * block (empty = whole block in; every key = whole block out). The result is
 * collapsed to the cheap extremes so the rest of the app can short-circuit:
 * `'all'` when every line of every block is in (a plain `git add`), `'none'`
 * when nothing is, otherwise a map of just the contributing blocks — each with
 * the patch for its kept lines and the exclusions to restore the checkboxes.
 */
export function buildFileSelection(
  path: string,
  meta: DisplayMeta,
  blocks: ChangeBlock[],
  excludedFor: (blockIndex: number) => ReadonlySet<string>
): FileSelection {
  const map = new Map<number, BlockSelection>()
  let anyPartialBlock = false
  for (const block of blocks) {
    const lines = listBlockLines(block)
    const excluded = excludedFor(block.index)
    const keptCount = lines.reduce((n, l) => (excluded.has(lineKey(l)) ? n : n + 1), 0)
    if (keptCount === 0) continue // block fully excluded — leave it out of the map
    if (keptCount < lines.length) anyPartialBlock = true
    const patch = buildBlockPatch(path, meta, blocks, block.index, (l) => !excluded.has(lineKey(l)))
    map.set(block.index, { patch, excluded: new Set(excluded) })
  }
  if (map.size === 0) return 'none'
  if (map.size === blocks.length && !anyPartialBlock) return 'all'
  return map
}

/**
 * Paint a set of changed lines to a single membership state, over the file's
 * current per-block exclusions (`base`). `exclude` true leaves every line in
 * `lines` *out* of the commit, false puts them all back *in*; lines not listed
 * keep their `base`. The write is a fixed-value set (not a flip), so painting the
 * same line twice is a no-op — which is what lets a drag recompute its whole
 * range from scratch on every move without flicker. Flows across blocks (`owner`
 * maps a line key to its block). Returns the normalized `FileSelection`.
 */
export function paintSelection(
  path: string,
  meta: DisplayMeta,
  blocks: ChangeBlock[],
  owner: ReadonlyMap<string, number>,
  base: (blockIndex: number) => ReadonlySet<string>,
  lines: Iterable<ChangedLine>,
  exclude: boolean
): FileSelection {
  const overrides = new Map<number, Set<string>>()
  for (const line of lines) {
    const key = lineKey(line)
    const blockIndex = owner.get(key)
    if (blockIndex === undefined) continue
    let excluded = overrides.get(blockIndex)
    if (!excluded) {
      excluded = new Set(base(blockIndex))
      overrides.set(blockIndex, excluded)
    }
    if (exclude) excluded.add(key)
    else excluded.delete(key)
  }
  return buildFileSelection(path, meta, blocks, (i) => overrides.get(i) ?? base(i))
}

/**
 * The changed lines a drag covers — the contiguous run from its `anchor` line to
 * the line currently under the pointer, inclusive, in the order the diff renders
 * them. In unified view that's a single interleaved column (each block's
 * deletions then its additions); in split view each side has its own gutter, so
 * the run stays on the anchor's side. Order-independent of drag direction (the
 * run is the same whether the pointer is above or below the anchor), so dragging
 * back past the anchor simply shrinks the run — overshoot corrects itself.
 * Returns [] when `current` isn't on the anchor's track (e.g. the pointer
 * drifted into the other split column), so the caller can keep the last range.
 */
export function rangeChangedLines(
  blocks: ChangeBlock[],
  unified: boolean,
  anchor: ChangedLine,
  current: ChangedLine
): ChangedLine[] {
  const order = unified
    ? blocks.flatMap(listBlockLines)
    : blocks.flatMap((b) => listBlockLines(b).filter((l) => l.type === anchor.type))
  const at = (line: ChangedLine) =>
    order.findIndex((l) => l.type === line.type && l.lineNumber === line.lineNumber)
  const a = at(anchor)
  const c = at(current)
  if (a === -1 || c === -1) return []
  return a <= c ? order.slice(a, c + 1) : order.slice(c, a + 1)
}
