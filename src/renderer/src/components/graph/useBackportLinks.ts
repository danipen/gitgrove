// Data feed for the backport twins: fetch patch-ids for the linkable commits
// in view (one batched IPC call for the unknowns, cached per repo for the
// session — a commit's patch-id never changes) and pair them up via links.ts.
// `linkable` scopes the pipeline to the mainline + release-line chains, so a
// repo without release lines never runs it, and feature branches never enter
// it. Best-effort decoration: a failure marks the batch as unknown and never
// surfaces an error. Runs in an effect, after the graph has painted.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphLayout } from './layout'
import { type BackportLink, backportLinks } from './links'

export function useBackportLinks(
  repoPath: string,
  layout: GraphLayout,
  linkable: ReadonlySet<number>
): BackportLink[] {
  // hash → patch-id (null = known to have none): survives re-layouts/filters.
  const cache = useRef(new Map<string, string | null>())
  const cacheRepo = useRef(repoPath)
  const [version, setVersion] = useState(0)
  if (cacheRepo.current !== repoPath) {
    cacheRepo.current = repoPath
    cache.current = new Map()
  }

  useEffect(() => {
    if (linkable.size === 0) return
    const missing = layout.nodes
      .filter(
        (node) => !node.isMerge && linkable.has(node.chain) && !cache.current.has(node.commit.hash)
      )
      .map((node) => node.commit.hash)
    if (missing.length === 0) return
    let cancelled = false
    window.gitgrove
      .graphPatchIds(repoPath, missing)
      .catch(() => ({}) as Record<string, string>)
      .then((ids) => {
        if (cancelled) return
        for (const hash of missing) cache.current.set(hash, ids[hash] ?? null)
        setVersion((v) => v + 1)
      })
    return () => {
      cancelled = true
    }
  }, [layout, linkable, repoPath])

  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks the cache ref's contents
  return useMemo(() => {
    if (linkable.size === 0) return []
    const ids = new Map<string, string>()
    for (const [hash, id] of cache.current) {
      if (id) ids.set(hash, id)
    }
    // Pair only linkable nodes: the cache may hold ids for chains that have
    // since stopped being linkable (an unpinned release line, say).
    return backportLinks(
      layout.nodes.filter((node) => linkable.has(node.chain)),
      ids
    )
  }, [layout, linkable, version])
}
