// The command palette's file search: a per-repo cache of every tracked path
// (plus its case-folded twin, folded once rather than per keystroke), fuzzy-
// ranked here in main so only the few best matches ever cross IPC — shipping
// a 500k-path list to the renderer on each keystroke would stall it.
//
// Freshness: the cache is keyed to the index file's mtime + size. Anything
// that changes the tracked set (add, rm, checkout, pull, a commit) rewrites
// the index, so one cheap stat per query is enough to know when to re-list.
//
// Responsiveness: main serves every window's IPC, so a long scan must never
// hog it. The scan yields to the event loop every CHUNK paths, and a newer
// query from the same caller abandons the older one at its next yield — fast
// typing never piles up scans.

import { stat } from 'node:fs/promises'
import { foldCase, fuzzyMatchPath, fuzzyScorePath, normalizeQuery, TopMatches } from '@shared/fuzzy'
import type { FileSearchResult } from '@shared/types'
import { getIndexPath, listTrackedFiles } from '../git/read'

/** Paths scored between yields: a few ms of work, never a visible stall. */
const CHUNK = 20_000
/** Repos kept indexed at once (multi-window); the least recently used goes. */
const MAX_CACHED_REPOS = 3

interface FileIndex {
  paths: string[]
  folded: string[]
  /** Index-file mtime + size when `paths` was listed. */
  stamp: string
}

const indexes = new Map<string, FileIndex>()
const loading = new Map<string, Promise<FileIndex>>()
const indexPaths = new Map<string, string>()
/** The newest query per caller; older scans for the same caller bail out. */
const latestQuery = new Map<string, number>()
let querySeq = 0

async function indexStamp(repoPath: string): Promise<string> {
  let indexPath = indexPaths.get(repoPath)
  if (!indexPath) {
    indexPath = await getIndexPath(repoPath)
    indexPaths.set(repoPath, indexPath)
  }
  // No index yet (a fresh repo with nothing staged) is a state too.
  const info = await stat(indexPath).catch(() => null)
  return info ? `${info.mtimeMs}:${info.size}` : 'none'
}

/** The repo's file index, re-listed only when the git index has changed. */
async function fileIndex(repoPath: string): Promise<FileIndex> {
  const stamp = await indexStamp(repoPath)
  const cached = indexes.get(repoPath)
  if (cached?.stamp === stamp) {
    // Re-insert to mark it most recently used.
    indexes.delete(repoPath)
    indexes.set(repoPath, cached)
    return cached
  }
  // Concurrent queries during a (possibly seconds-long) first listing share it.
  const pending = loading.get(repoPath)
  if (pending) return pending
  const load = listTrackedFiles(repoPath)
    .then((paths) => {
      const index = { paths, folded: paths.map(foldCase), stamp }
      indexes.delete(repoPath)
      indexes.set(repoPath, index)
      while (indexes.size > MAX_CACHED_REPOS) indexes.delete(indexes.keys().next().value!)
      return index
    })
    .finally(() => loading.delete(repoPath))
  loading.set(repoPath, load)
  return load
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * The `limit` tracked files best matching `query`, best first. `caller`
 * identifies who's typing (one window's palette): its newer query supersedes
 * this one, which then resolves null. An empty query matches nothing — the
 * palette shows other things until the user types.
 */
export async function searchFiles(
  repoPath: string,
  query: string,
  limit: number,
  caller: string
): Promise<FileSearchResult | null> {
  const seq = ++querySeq
  latestQuery.set(caller, seq)
  const needle = normalizeQuery(query)
  const index = await fileIndex(repoPath)
  // Typed past while the index loaded: don't even start scanning.
  if (latestQuery.get(caller) !== seq) return null
  if (needle.length === 0) return { matches: [], total: 0 }

  const top = new TopMatches<number>(limit)
  const { paths, folded } = index
  for (let start = 0; start < paths.length; start += CHUNK) {
    if (start > 0) {
      await yieldToEventLoop()
      if (latestQuery.get(caller) !== seq) return null
    }
    const end = Math.min(start + CHUNK, paths.length)
    for (let i = start; i < end; i++) {
      const score = fuzzyScorePath(needle, paths[i], folded[i])
      if (score !== null) top.add(i, score, paths[i].length)
    }
  }
  // Positions only for the winners — the scan itself never allocates.
  const matches = top.items().map((i) => {
    const match = fuzzyMatchPath(needle, paths[i], folded[i])!
    return { path: paths[i], score: match.score, positions: match.positions }
  })
  return { matches, total: top.total }
}
