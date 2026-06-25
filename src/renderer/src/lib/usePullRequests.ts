// The GitHub-derived slice of the open repo: the "not pushed yet" SHA set (grays
// out "View on GitHub" for commits no host page has yet), the pull requests that
// drive branch badges + the "Create Pull Request" banner, and the focus/poll
// refreshes that keep CI status honest without background polling.
//
// PRs are fetched on demand, by branch — not by pulling the repo's recent PRs.
// On a busy monorepo the "recent" window is only hours wide, so an older PR
// falls out of it; a head-ref lookup finds it regardless. Two tiers:
//   • the current branch (the one on the toolbar pill) is fetched on open, after
//     sync and on every window focus — it's always present and fresh;
//   • the branch switcher asks for its viewport's branches as it opens/scrolls
//     (see fetchBranchPrs), so a 25k-branch repo only ever queries what's shown.
// A per-branch cache (`null` = checked, no PR) backs both, so badges render
// instantly on reopen while a background revalidate keeps them honest.
//
// Everything here is gated to GitHub hosts by the host info passed in; on any
// other host the data stays empty and the effects are inert.

import { compareUrl } from '@shared/git-host-urls'
import type {
  BranchInfo,
  PullRequestInfo,
  RepoHostInfo,
  RepoSummary,
  SyncStatus
} from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface Params {
  getRepoPath: () => string | undefined
  repo: RepoSummary | null
  hostInfo: RepoHostInfo | null
  branch: BranchInfo | null
  sync: SyncStatus | null
}

/** Options for a branch-PR fetch: `revalidate` re-asks even cached branches
 *  (popup open/reopen wants fresh badges); without it, already-cached branches
 *  are skipped (scrolling past rows we've already looked up costs nothing). */
interface FetchOpts {
  revalidate?: boolean
}

export function usePullRequests({ getRepoPath, repo, hostInfo, branch, sync }: Params) {
  // Full SHAs of commits not yet on any remote: their host commit page 404s, so
  // "View on GitHub" is grayed out for them. Loaded only for GitHub hosts.
  const [unpushed, setUnpushed] = useState<Set<string>>(new Set())
  // Per-branch PR cache: a PullRequestInfo when the branch has one, or `null`
  // once we've checked and found none (so we don't re-ask on every scroll).
  const [prCache, setPrCache] = useState<Map<string, PullRequestInfo | null>>(new Map())
  // False until the current branch's first PR fetch resolves, so the "Create
  // Pull Request" banner never flashes before we know whether it has a PR.
  const [prsLoaded, setPrsLoaded] = useState(false)
  const unpushedRef = useRef<Set<string>>(unpushed)
  unpushedRef.current = unpushed
  // Mirrors kept for async callbacks that decide what to (re)fetch without
  // needing to re-run when the cache or current branch changes identity.
  const prCacheRef = useRef(prCache)
  prCacheRef.current = prCache
  const currentBranchRef = useRef<string | undefined>(branch?.current)
  currentBranchRef.current = branch?.detached ? undefined : branch?.current
  // Branches with a request in flight — never queried twice concurrently.
  const inFlightRef = useRef<Set<string>>(new Set())

  // Look up PRs for specific branches by head ref and fold them into the cache.
  // Branches absent from the result are cached as `null` (checked, no PR) so we
  // don't keep re-asking. A failure leaves the cache untouched (badges persist).
  const fetchBranchPrs = useCallback(
    async (repoPath: string, branches: string[], opts: FetchOpts = {}) => {
      const wanted = branches.filter((b) => {
        if (!b || inFlightRef.current.has(b)) return false
        return opts.revalidate || !prCacheRef.current.has(b)
      })
      if (wanted.length === 0) return
      for (const b of wanted) inFlightRef.current.add(b)
      let found: PullRequestInfo[] | null = null
      try {
        found = await window.gitgrove.pullRequestsForBranches(repoPath, wanted)
      } catch {
        found = null
      }
      for (const b of wanted) inFlightRef.current.delete(b)
      // Repo switched out from under the request — discard the stale answer.
      if (found === null || getRepoPath() !== repoPath) return
      setPrCache((prev) => {
        const next = new Map(prev)
        for (const b of wanted) next.set(b, null)
        for (const pr of found) next.set(pr.headBranch, pr)
        return next
      })
    },
    [getRepoPath]
  )

  // Load the GitHub-derived data for a repo: the "not pushed yet" SHA set (grays
  // out "View on GitHub") and the *current* branch's PR (the always-visible pill
  // badge, refreshed on open/sync/focus). Callers gate this to GitHub hosts. A
  // transient failure keeps the previous values rather than clearing the UI.
  const loadGithubData = useCallback(
    async (repoPath: string) => {
      const current = currentBranchRef.current
      const [shas] = await Promise.all([
        window.gitgrove.unpushedCommits(repoPath).catch(() => null),
        current ? fetchBranchPrs(repoPath, [current], { revalidate: true }) : Promise.resolve()
      ])
      if (getRepoPath() !== repoPath) return
      if (shas) setUnpushed(new Set(shas))
      setPrsLoaded(true)
    },
    [getRepoPath, fetchBranchPrs]
  )

  /** Clear the GitHub data on a repo switch (before the new host resolves). */
  const resetGithub = useCallback(() => {
    setUnpushed(new Set())
    setPrCache(new Map())
    setPrsLoaded(false)
    inFlightRef.current.clear()
  }, [])

  // Branch name → its PR, for the badge and the "Open Pull Request" menu entry.
  // Same-repo PRs only: a fork PR's head ref names a branch in another repo, so
  // matching by name alone would be wrong. `null` cache entries (no PR) drop out.
  const prByBranch = useMemo(() => {
    const map = new Map<string, PullRequestInfo>()
    for (const [name, pr] of prCache) {
      if (pr && !pr.isCrossRepo) map.set(name, pr)
    }
    return map
  }, [prCache])

  // The compare URL for the "Create Pull Request" banner, or null when it
  // shouldn't show: only on a GitHub host, for a published branch (has an
  // upstream) that isn't the default branch and has no PR at all yet.
  const createPrUrl = useMemo(() => {
    // Wait until the current branch's PRs have loaded — otherwise the banner
    // flashes on every repo open before we know whether it already has a PR.
    if (!prsLoaded) return null
    if (hostInfo?.provider !== 'github' || !hostInfo.webUrl) return null
    if (!branch || branch.detached || !branch.defaultBranch) return null
    const current = branch.current
    if (!current || current === branch.defaultBranch) return null
    // Any PR — open, merged or closed — means the branch's PR story is already
    // told (the menu's "Open Pull Request #N" reaches it), so don't nag to
    // create another. In particular, a just-merged branch must not reopen this.
    if (!sync?.upstream || prCache.get(current)) return null
    return compareUrl(hostInfo.webUrl, branch.defaultBranch, current)
  }, [hostInfo, branch, sync, prCache, prsLoaded])

  // Refresh the current branch's PR + CI when the window regains focus — the
  // cheap way to catch a build that finished while the user was away.
  useEffect(() => {
    if (hostInfo?.provider !== 'github' || !repo) return
    const repoPath = repo.path
    const onFocus = () => loadGithubData(repoPath)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [hostInfo, repo, loadGithubData])

  // While the window is focused AND the current branch's check is still running,
  // poll every 30s so a pending dot turns green/red on its own. The moment it
  // settles the effect re-runs with no timer, so it's silent when CI is done.
  const current = currentBranchRef.current
  const headPending = current ? prByBranch.get(current)?.checks === 'pending' : false
  useEffect(() => {
    if (hostInfo?.provider !== 'github' || !repo || !headPending) return
    const repoPath = repo.path
    const timer = setInterval(() => {
      if (document.hasFocus()) loadGithubData(repoPath)
    }, 30_000)
    return () => clearInterval(timer)
  }, [hostInfo, repo, headPending, loadGithubData])

  return { unpushedRef, prByBranch, createPrUrl, loadGithubData, fetchBranchPrs, resetGithub }
}
