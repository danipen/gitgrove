// Data feed for squash-merged branches: asks main which branch tips landed on
// the default branch by content (squash / rebase merge — see squash.ts and
// main/git/read/squash-landings.ts) and hands the layout tip → landing.
// Re-asks only when the question changes (a new mainline tip or candidate
// set), so watcher refreshes that change nothing never re-run git. The last
// answer stays up while a new one loads: no flicker back to "unmerged".
// Best-effort decoration: a failure keeps the previous answer, never an error.

import type { Commit } from '@shared/types'
import { useEffect, useMemo, useState } from 'react'
import { squashQuery } from './squash'

const NO_LANDINGS: ReadonlyMap<string, string> = new Map()

export function useSquashLandings(
  repoPath: string,
  commits: readonly Commit[],
  remotes: readonly string[],
  defaultBranch: string | null
): ReadonlyMap<string, string> {
  const query = useMemo(
    () => squashQuery(commits, remotes, defaultBranch),
    [commits, remotes, defaultBranch]
  )
  // A string key: fresh arrays every refresh must not re-trigger the fetch.
  const key = query
    ? `${repoPath}|${query.mainline[0]}|${query.candidates.map((c) => `${c.tip}:${c.base}`).join(',')}`
    : null
  const [answer, setAnswer] = useState<{ repoPath: string; landings: ReadonlyMap<string, string> }>(
    { repoPath, landings: NO_LANDINGS }
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: key encodes repoPath + query
  useEffect(() => {
    if (!query) return
    let cancelled = false
    window.gitgrove
      .graphSquashLandings(repoPath, query.mainline, query.candidates)
      .then((record) => {
        if (!cancelled) setAnswer({ repoPath, landings: new Map(Object.entries(record)) })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [key])

  // Never leak another repo's answer across a switch.
  return query && answer.repoPath === repoPath ? answer.landings : NO_LANDINGS
}
