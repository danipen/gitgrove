// Pure shaping for the clone dialog's repository picker: filter by typed text
// and group by owner, with the signed-in user's own repositories floated to
// the top (the rest alphabetical) — the GitHub-Desktop ordering. Kept pure and
// separate from the component so the grouping is unit-tested without a DOM.

import type { RemoteRepo } from '@shared/types'

export interface RepoGroup {
  owner: string
  repos: RemoteRepo[]
}

/**
 * Does `repo` match the filter? Every whitespace-separated term must appear in
 * `owner/name` (case-insensitive), so "git grove" finds "danipen/gitgrove" and
 * a multi-word filter narrows progressively. An empty filter matches all.
 */
function matches(repo: RemoteRepo, terms: string[]): boolean {
  if (terms.length === 0) return true
  const haystack = repo.fullName.toLowerCase()
  return terms.every((t) => haystack.includes(t))
}

/**
 * Filter then group `repos` by owner. The group for `selfLogin` comes first as
 * "Your repositories"; the rest follow alphabetically by owner. Within each
 * group repos are sorted alphabetically by name (case-insensitive) — the
 * GitHub-Desktop ordering, predictable for browsing a long list.
 */
export function groupReposByOwner(
  repos: RemoteRepo[],
  selfLogin: string,
  filter: string
): RepoGroup[] {
  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const byOwner = new Map<string, RepoGroup>()
  for (const repo of repos) {
    if (!matches(repo, terms)) continue
    const key = repo.owner.toLowerCase()
    const group = byOwner.get(key)
    if (group) group.repos.push(repo)
    else byOwner.set(key, { owner: repo.owner, repos: [repo] })
  }
  const self = selfLogin.toLowerCase()
  const groups = [...byOwner.values()].sort((a, b) => {
    if (a.owner.toLowerCase() === self) return -1
    if (b.owner.toLowerCase() === self) return 1
    return a.owner.toLowerCase().localeCompare(b.owner.toLowerCase())
  })
  for (const group of groups) {
    group.repos.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }
  return groups
}
