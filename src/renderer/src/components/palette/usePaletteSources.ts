// The command palette's asynchronous sources: what it loads when it opens
// (every ref, the worktrees, the recent repos) and what it asks for as the
// user types (main's fuzzy file search, a pasted commit id's commit). Each
// source fills in on its own — the palette never waits for the slowest one.
//
// Stale answers are dropped by request identity: a load number for the
// on-open loads (a repo switch reloads), and a per-keystroke counter for the
// typed lookups, so a slow reply for an old query can never overwrite a newer
// one.

import { normalizeQuery } from '@shared/fuzzy'
import type { Commit, FileSearchMatch, RecentRepo, RefEntry, WorktreeInfo } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { EXPANDED_ROWS, looksLikeCommitId, parseScope } from './paletteResults'

/** Typing pause before asking main — short enough to feel live. */
const LOOKUP_DEBOUNCE_MS = 40

export interface LoadedSources {
  refs: RefEntry[] | null
  worktrees: WorktreeInfo[] | null
  repos: RecentRepo[] | null
  fileMatches: FileSearchMatch[]
  filesLoading: boolean
  commit: Commit | null
}

/** Mounted with the open palette: loads on mount, looks up as `query` changes. */
export function usePaletteSources(repoPath: string | null, query: string): LoadedSources {
  const [refs, setRefs] = useState<RefEntry[] | null>(null)
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null)
  const [repos, setRepos] = useState<RecentRepo[] | null>(null)
  const [fileMatches, setFileMatches] = useState<FileSearchMatch[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [commit, setCommit] = useState<Commit | null>(null)
  const load = useRef(0)
  const lookup = useRef(0)

  // On open: everything that doesn't depend on the query, loaded fresh (refs
  // move on between opens) and in parallel.
  useEffect(() => {
    const id = ++load.current
    const current = () => load.current === id
    const gg = window.gitgrove
    setRefs(repoPath ? null : [])
    setWorktrees(repoPath ? null : [])
    setRepos(null)
    setFileMatches([])
    setCommit(null)
    gg.recentRepos()
      .then((list) => current() && setRepos(list))
      .catch(() => current() && setRepos([]))
    if (!repoPath) return
    gg.refs(repoPath)
      .then((list) => current() && setRefs(list))
      .catch(() => current() && setRefs([]))
    gg.worktreeList(repoPath)
      .then((list) => current() && setWorktrees(list))
      .catch(() => current() && setWorktrees([]))
  }, [repoPath])

  // As the user types: the file search and the commit-id lookup, debounced.
  const { scope, text } = parseScope(query)
  const fileQuery = repoPath && (scope === 'all' || scope === 'files') ? text : ''
  const commitQuery = repoPath && scope === 'all' && looksLikeCommitId(text) ? text : ''
  useEffect(() => {
    const id = ++lookup.current
    const current = () => lookup.current === id
    const needFiles = normalizeQuery(fileQuery).length > 0
    setFilesLoading(needFiles)
    if (!repoPath || (!needFiles && !commitQuery)) {
      setFileMatches([])
      return
    }
    const gg = window.gitgrove
    const timer = setTimeout(() => {
      if (needFiles) {
        gg.searchFiles(repoPath, fileQuery, EXPANDED_ROWS)
          .then((result) => {
            // null: main dropped it for a newer query of ours — that one answers.
            if (!current() || !result) return
            setFileMatches(result.matches)
            setFilesLoading(false)
          })
          .catch(() => current() && setFilesLoading(false))
      }
      if (commitQuery) {
        gg.log(repoPath, { ref: commitQuery.trim(), limit: 1 })
          .then((commits) => current() && setCommit(commits[0] ?? null))
          // Not a commit (or ambiguous): nothing to offer.
          .catch(() => current() && setCommit(null))
      }
    }, LOOKUP_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [repoPath, fileQuery, commitQuery])

  return { refs, worktrees, repos, fileMatches, filesLoading, commit }
}
