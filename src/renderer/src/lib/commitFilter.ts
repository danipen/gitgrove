// Client-side commit filtering for the File History list — a bounded, already
// loaded snapshot (the main History tab filters server-side via `git log
// --grep`, since it pages through a far deeper history). Mirrors that search's
// semantics: every whitespace-separated term must appear (case-insensitive
// substring), matched against the subject and author name together — or, like
// the server search resolving a pasted id, as a prefix of the commit's hash.

import type { Commit } from '@shared/types'

/** Split a filter query into the lowercased terms that all must match. */
export function filterTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** The commits passing the query (the input array when the query is empty). */
export function filterCommits(commits: Commit[], query: string): Commit[] {
  const terms = filterTerms(query)
  if (terms.length === 0) return commits
  return commits.filter((commit) => {
    const haystack = `${commit.subject} ${commit.authorName}`.toLowerCase()
    const hash = commit.hash.toLowerCase()
    return terms.every((term) => haystack.includes(term) || hash.startsWith(term))
  })
}
