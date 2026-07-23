// The files a commit changed: status-letter mapping and the combined
// raw+numstat parse that yields one ChangedFile per path with line counts.

import type { ChangedFile, FileStatus } from '@shared/types'
import { EMPTY_TREE, isNoParentError, runGit } from './core'

function parseStatusLetter(letter: string): FileStatus {
  switch (letter[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'added'
    case 'M':
    case 'T':
      return 'modified'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

/**
 * Parse combined `diff-tree -z --raw --numstat` output (raw records first,
 * then numstat). NUL-delimited, so any filename — unicode, tabs, newlines —
 * parses exactly; without `-z` git C-quotes such paths and the parse breaks.
 * Token layout (NUL-separated):
 *   raw:      `:oldmode newmode oldsha newsha S` `path` (R/C: `src` `dst`)
 *   numstat:  `ins\tdel\tpath`                  (R/C: `ins\tdel\t` `src` `dst`)
 * Exported for tests.
 */
export function parseRawNumstat(out: string): ChangedFile[] {
  const tokens = out.split('\0')
  const files: ChangedFile[] = []
  const byPath = new Map<string, ChangedFile>()
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok) continue
    if (tok.startsWith(':')) {
      const fields = tok.split(' ')
      const status = fields[4] ?? ''
      // Gitlink mode on either side marks a submodule entry (the other side
      // is 000000 when the submodule was added or removed).
      const submodule = fields[0] === ':160000' || fields[1] === '160000' || undefined
      const rename = status.startsWith('R') || status.startsWith('C')
      const oldPath = rename ? tokens[++i] : undefined
      const path = tokens[++i]
      // Dedup guard: a single tree-pair diff yields each path once, but a
      // duplicate would make the file-tree renderer throw.
      if (path && !byPath.has(path)) {
        const file: ChangedFile = {
          path,
          oldPath,
          status: parseStatusLetter(status),
          staged: true,
          submodule
        }
        byPath.set(path, file)
        files.push(file)
      }
      continue
    }
    const m = tok.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s)
    if (!m) continue
    let path = m[3]
    if (!path) {
      // Rename numstat: empty inline path, then src + dst tokens.
      i += 2
      path = tokens[i] ?? ''
    }
    const file = byPath.get(path)
    if (file) {
      const binary = m[1] === '-' && m[2] === '-'
      file.binary = binary
      file.insertions = binary ? undefined : Number(m[1])
      file.deletions = binary ? undefined : Number(m[2])
    }
  }
  // Plain byte sort, matching the snapshot's ordering contract.
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The files changed across a commit RANGE (`base` → `head`) — the Graph tab's
 * branch-changes view. A null `base` (a branch starting at a root commit)
 * diffs against the empty tree. Same one-spawn raw+numstat parse as
 * getCommitFiles.
 */
export async function getRangeFiles(
  repoPath: string,
  base: string | null,
  head: string
): Promise<ChangedFile[]> {
  const out = await runGit(repoPath, [
    'diff-tree',
    '--no-commit-id',
    '-M',
    '-r',
    '-z',
    '--raw',
    '--numstat',
    base ?? EMPTY_TREE,
    head
  ])
  return parseRawNumstat(out)
}

/**
 * The merge base of two commits — the newest commit reachable from both — or
 * null when they share no history. The branch-changes view diffs a branch
 * from merge-base(upstream, tip) rather than its fork point: after the branch
 * merges its upstream back in, the fork-point diff would count everything the
 * upstream did in between as the branch's own changes, while the merge base
 * is the last point both sides agreed — so `mergeBase..tip` is exactly the
 * branch's own work, matching what its pull request shows.
 */
export async function getMergeBase(repoPath: string, a: string, b: string): Promise<string | null> {
  // Exit code 1 = no common ancestor (unrelated histories), not an error.
  const out = await runGit(repoPath, ['merge-base', a, b], [1])
  return out.trim() || null
}

export async function getCommitFiles(repoPath: string, hash: string): Promise<ChangedFile[]> {
  // Diff against the first parent so merge commits report only what the merge
  // introduced on top of the mainline rather than the union of every parent.
  // `diff-tree -m --first-parent` does NOT do this —
  // `-m` emits a section per parent and silently ignores `--first-parent`,
  // producing the union — so we name the two trees explicitly. One spawn
  // carries status AND line counts; root commits (no parent) retry against
  // the empty tree.
  const args = ['diff-tree', '--no-commit-id', '-M', '-r', '-z', '--raw', '--numstat']
  let out: string
  try {
    out = await runGit(repoPath, [...args, `${hash}^`, hash])
  } catch (e) {
    if (!isNoParentError(e)) throw e
    out = await runGit(repoPath, [...args, EMPTY_TREE, hash])
  }
  return parseRawNumstat(out)
}
