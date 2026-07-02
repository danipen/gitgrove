// The Graph tab's commit feed: every commit reachable from any local branch,
// remote branch or tag — plus HEAD, so a detached checkout never disappears
// from the diagram. Explicit ref globs rather than `--all`, which would also
// walk refs/stash and refs/notes.

import type { Commit, GraphLogOptions } from '@shared/types'
import { runGit } from './core'
import { LOG_FORMAT, parseLog } from './log'

/** Default window fed to the diagram; the renderer offers "show more" past it. */
export const GRAPH_LOG_LIMIT = 2000

export async function getGraphLog(
  repoPath: string,
  options: GraphLogOptions = {}
): Promise<Commit[]> {
  const { limit = GRAPH_LOG_LIMIT, since } = options
  // `--date-order` is load-bearing: like --topo-order it guarantees every
  // commit appears before its parents (what the layout's single forward pass
  // relies on), but it keeps commits in timestamp order otherwise — so the
  // diagram's left-to-right axis reads as time and the date header is honest.
  const args = ['log', '-z', `--format=${LOG_FORMAT}`, '--date-order', `--max-count=${limit}`]
  if (since) args.push(`--since=${since}`)
  args.push('--branches', '--remotes', '--tags')
  try {
    // HEAD is added explicitly for detached checkouts (no branch points there).
    return parseLog(await runGit(repoPath, [...args, 'HEAD']))
  } catch {
    // Unborn HEAD makes git reject the HEAD arg outright; remote branches can
    // still exist (init + fetch), so retry without it. A repo with no refs at
    // all fails again — an empty graph, not an error.
    return parseLog(await runGit(repoPath, args).catch(() => ''))
  }
}
