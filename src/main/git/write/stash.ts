// Stash operations and the NUL-delimited parse of `git stash list`.

import type { StashEntry } from '@shared/types'
import { run, runRead } from '../exec'
import { AUTO_STASH_MARKER, ENGLISH } from './internal'

/** Field count of the stash-list format below. */
const STASH_FIELDS = 4

/**
 * Parse `git stash list -z` in our NUL-joined `%gd %H %gs %cr` format: a flat
 * NUL stream read in groups of four. NUL because `%gs` carries the user's
 * stash message, which can contain any byte except NUL. Exported for tests.
 */
export function parseStashList(out: string): StashEntry[] {
  const tokens = out.split('\0')
  const entries: StashEntry[] = []
  for (let i = 0; i + STASH_FIELDS <= tokens.length; i += STASH_FIELDS) {
    const [ref, sha, subject, relativeDate] = tokens.slice(i, i + STASH_FIELDS)
    const m = ref.match(/stash@\{(\d+)\}/)
    if (!m) continue
    // `%gs` looks like "On main: message" or "WIP on main: deadbeef Subject" —
    // the prefix carries the branch the stash was taken on (ref names can't
    // contain ':', so the first ': ' is unambiguous; detached HEAD records
    // "(no branch)", which means no branch to remember).
    const prefix = subject.match(/^(?:WIP on|On) ([^:]+): /)
    const branchName = prefix && prefix[1] !== '(no branch)' ? prefix[1] : null
    const message = prefix ? subject.slice(prefix[0].length) : subject
    const auto = message === AUTO_STASH_MARKER
    entries.push({
      index: Number(m[1]),
      sha,
      // Auto-stashes carry only the marker — never show it; the UI labels them.
      message: auto ? '' : message,
      branchName,
      auto,
      relativeDate
    })
  }
  return entries
}

export async function listStashes(repoPath: string): Promise<StashEntry[]> {
  const out = await runRead(repoPath, [
    'stash',
    'list',
    '-z',
    '--format=%gd%x00%H%x00%gs%x00%cr'
  ]).catch(() => '')
  return parseStashList(out)
}

export async function stashSave(
  repoPath: string,
  opts: { message?: string; includeUntracked?: boolean; paths?: string[] } = {}
): Promise<void> {
  const args = ['stash', 'push']
  if (opts.includeUntracked !== false) args.push('-u')
  if (opts.message?.trim()) args.push('-m', opts.message.trim())
  // Stash only the given paths (NUL pathspecs over stdin — no argv limits).
  if (opts.paths && opts.paths.length > 0) {
    args.push('--pathspec-from-file=-', '--pathspec-file-nul')
    await run(repoPath, args, { input: opts.paths.join('\0') })
    return
  }
  await run(repoPath, args)
}

export async function stashApply(repoPath: string, index: number, pop: boolean): Promise<void> {
  try {
    // LC_ALL=C so the clash detection below is locale-proof.
    await run(repoPath, ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`], { env: ENGLISH })
  } catch (e) {
    // Git's "would be overwritten by merge" reads like a merge went wrong;
    // what actually happened is the working tree already touches the same
    // files. Say that, and what to do about it. The stash is untouched.
    const message = e instanceof Error ? e.message : String(e)
    if (/would be overwritten by merge/i.test(message)) {
      throw new Error(
        'Some of the stashed files also have new changes in your working tree. ' +
          'Commit, stash or discard those changes first — then apply this stash.'
      )
    }
    throw e
  }
}

export async function stashDrop(repoPath: string, index: number): Promise<void> {
  await run(repoPath, ['stash', 'drop', `stash@{${index}}`])
}
