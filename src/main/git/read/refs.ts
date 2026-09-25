// Every branch and tag in one read — what the command palette searches. One
// `for-each-ref` over refs/heads, refs/remotes and refs/tags; cheap even with
// tens of thousands of refs (it reads packed-refs, no history walk).

import type { RefEntry } from '@shared/types'
import { runGit } from './core'

const PREFIXES: [string, RefEntry['kind']][] = [
  ['refs/heads/', 'local'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag']
]

/**
 * Parse `for-each-ref` records of `refname NUL objectname NUL *objectname NUL
 * creatordate:unix NUL symref`, one per line (refnames can't hold NUL or a
 * newline, so this is exact). Symbolic refs (`origin/HEAD`) are pointers, not
 * branches, and drop out. Pure + exported for tests.
 */
export function parseRefs(out: string): RefEntry[] {
  const refs: RefEntry[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [refname, object, peeled, date, symref] = line.split('\0')
    if (symref) continue
    const prefix = PREFIXES.find(([p]) => refname.startsWith(p))
    if (!prefix) continue
    refs.push({
      kind: prefix[1],
      name: refname.slice(prefix[0].length),
      // An annotated tag names a tag object; `*objectname` is its commit.
      hash: peeled || object,
      date: Number(date) || 0
    })
  }
  return refs
}

/** All local branches, remote branches and tags, most recently touched first. */
export async function getRefs(repoPath: string): Promise<RefEntry[]> {
  const out = await runGit(repoPath, [
    'for-each-ref',
    '--sort=-creatordate',
    '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(creatordate:unix)%00%(symref)',
    'refs/heads',
    'refs/remotes',
    'refs/tags'
  ])
  return parseRefs(out)
}
