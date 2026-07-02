// The commit log: the NUL-joined log format and its parser, the paged history
// query, single-file history, the unpushed set, and a commit's index in HEAD.

import type { Commit, LogOptions } from '@shared/types'
import { runGit } from './core'

// Log fields, NUL-joined: subjects/bodies can contain any byte except NUL, so
// NUL is the only safe field separator. With `-z` git also terminates each
// commit record with NUL, so the whole output is one flat NUL stream parsed
// by fixed field count.
const LOG_FIELDS = ['%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%ar', '%D', '%P']
export const LOG_FORMAT = LOG_FIELDS.join('%x00')

/** Parse NUL-delimited `git log --format=LOG_FORMAT` output into commits. */
export function parseLog(out: string): Commit[] {
  const fields = out.split('\0')
  const commits: Commit[] = []
  for (let i = 0; i + LOG_FIELDS.length <= fields.length; i += LOG_FIELDS.length) {
    const [hash, shortHash, subject, body, authorName, authorEmail, date, relativeDate, refs] =
      fields.slice(i, i + 9)
    const parents = fields[i + 9]
    commits.push({
      hash,
      shortHash,
      subject,
      body: body.trim(),
      authorName,
      authorEmail,
      date,
      relativeDate,
      refs,
      parents: parents.trim() ? parents.trim().split(' ') : []
    } satisfies Commit)
  }
  return commits
}

export async function getLog(repoPath: string, options: LogOptions = {}): Promise<Commit[]> {
  const { ref, limit = 200, skip = 0, search } = options
  const query = (search ?? '').trim()
  const args = ['log', '-z', `--format=${LOG_FORMAT}`, `--max-count=${limit}`]
  if (skip > 0) args.push(`--skip=${skip}`)
  // Free-text message search: every whitespace-separated word must appear
  // (`--all-match` ANDs the `--grep`s), case-insensitively (`-i`) and as literal
  // text (`-F`) so regex metacharacters a user types aren't interpreted. Matched
  // against the whole message (subject + body), like the rest of git.
  const terms = query.split(/\s+/).filter(Boolean)
  if (terms.length > 0) {
    args.push('-i', '-F', '--all-match')
    for (const term of terms) args.push(`--grep=${term}`)
  }
  args.push(ref?.trim() ? ref : 'HEAD')

  const commits = parseLog(await runGit(repoPath, args))

  // A pasted commit id never matches `--grep` (it searches the message), so a
  // hex-looking query also tries to resolve as a commit; a hit is surfaced
  // first. `--quiet --verify` rejects unknown and ambiguous ids, `^{commit}`
  // peels tags; hex-only words ("added", "cafe") just fail to resolve and
  // cost one cheap rev-parse. First page only — paging must not re-add it.
  if (skip === 0 && /^[0-9a-f]{4,40}$/i.test(query)) {
    const hash = await runGit(repoPath, [
      'rev-parse',
      '--quiet',
      '--verify',
      `${query.toLowerCase()}^{commit}`
    ]).then(
      (out) => out.trim(),
      () => ''
    )
    if (hash && !commits.some((c) => c.hash === hash)) {
      const found = await runGit(repoPath, ['log', '-z', '-1', `--format=${LOG_FORMAT}`, hash])
      commits.unshift(...parseLog(found))
    }
  }
  return commits
}

/**
 * Full SHAs of every commit that lives on a local branch but on no remote — the
 * "not pushed yet" set. A host's `/commit/<sha>` page 404s for these, so the UI
 * grays out "View on GitHub" for them. `--branches --not --remotes` walks only
 * the distance the local branches are ahead of the remotes (cheap in practice),
 * and works whatever ref the history shows; callers gate it to repos with a
 * remote, where that distance is naturally bounded. Returns [] when there's no
 * history yet (unborn HEAD) or the walk fails for any reason.
 */
export async function getUnpushedCommits(repoPath: string): Promise<string[]> {
  const out = await runGit(repoPath, ['rev-list', '--branches', '--not', '--remotes']).catch(
    () => ''
  )
  return out.split('\n').filter(Boolean)
}

/**
 * `hash`'s 0-based position in `git log HEAD` — the count of commits reachable
 * from HEAD but not from `hash`, i.e. those strictly newer than it. Lets the
 * History list page far enough to reveal a commit the user jumped to from
 * elsewhere. Returns `-1` when `hash` isn't an ancestor of HEAD (it would never
 * appear in the list) or can't be resolved.
 */
export async function getCommitIndex(repoPath: string, hash: string): Promise<number> {
  // `hash..HEAD` excludes `hash` and its ancestors, so the count is exactly the
  // number of newer commits = `hash`'s index. An unrelated `hash` (not an
  // ancestor) makes git exit non-zero or yield a misleading count, so verify
  // ancestry first.
  const ancestor = await runGit(repoPath, ['merge-base', '--is-ancestor', hash, 'HEAD']).then(
    () => true,
    () => false
  )
  if (!ancestor) return -1
  const out = await runGit(repoPath, ['rev-list', '--count', `${hash}..HEAD`])
  const count = Number.parseInt(out.trim(), 10)
  return Number.isFinite(count) ? count : -1
}

/**
 * History of the commits that touched a single file, newest first. `--follow`
 * tracks the file across renames (it requires exactly one pathspec); `-M`
 * enables the rename detection it relies on. `ref` bounds the walk (a commit
 * for a History-tab file, HEAD for a working-tree file).
 */
export async function getFileHistory(
  repoPath: string,
  path: string,
  ref?: string,
  limit = 200
): Promise<Commit[]> {
  const args = [
    'log',
    '-z',
    '--follow',
    '-M',
    `--format=${LOG_FORMAT}`,
    `--max-count=${limit}`,
    ref?.trim() ? ref : 'HEAD',
    '--',
    path
  ]
  return parseLog(await runGit(repoPath, args))
}
