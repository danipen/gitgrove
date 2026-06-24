// The GitHub-derived slice of the open repo: the "not pushed yet" SHA set
// (grays out "View on GitHub" for commits no host page has yet), the open pull
// requests (branch badges + the "Create Pull Request" banner), and the focus/
// poll refreshes that keep CI status honest without background polling.
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

export function usePullRequests({ getRepoPath, repo, hostInfo, branch, sync }: Params) {
  // Full SHAs of commits not yet on any remote: their host commit page 404s, so
  // "View on GitHub" is grayed out for them. Loaded only for GitHub hosts.
  const [unpushed, setUnpushed] = useState<Set<string>>(new Set())
  // Open pull requests on the GitHub remote, matched to branches by head ref.
  const [pullRequests, setPullRequests] = useState<PullRequestInfo[]>([])
  // False until the first PR fetch for the current repo resolves, so the
  // "Create Pull Request" banner never flashes before we know the branch's PRs.
  const [prsLoaded, setPrsLoaded] = useState(false)
  const unpushedRef = useRef<Set<string>>(unpushed)
  unpushedRef.current = unpushed

  // Load the GitHub-derived data for a repo: the "not pushed yet" SHA set (grays
  // out "View on GitHub") and the open pull requests (branch badges). Callers
  // gate this to GitHub hosts, so neither request runs where it isn't used. A
  // transient failure keeps the previous values rather than clearing the UI.
  const loadGithubData = useCallback(
    async (repoPath: string) => {
      const [shas, prs] = await Promise.all([
        window.gitgrove.unpushedCommits(repoPath).catch(() => null),
        window.gitgrove.pullRequests(repoPath).catch(() => null)
      ])
      if (getRepoPath() !== repoPath) return
      if (shas) setUnpushed(new Set(shas))
      if (prs) {
        setPullRequests(prs)
        setPrsLoaded(true)
      }
    },
    [getRepoPath]
  )

  /** Clear the GitHub data on a repo switch (before the new host resolves). */
  const resetGithub = useCallback(() => {
    setUnpushed(new Set())
    setPullRequests([])
    setPrsLoaded(false)
  }, [])

  // Map a branch name to its most recent PR of any state (PRs arrive
  // newest-activity first, so the first match wins). Same-repo PRs only: a fork
  // PR's head ref names a branch in another repo, so matching by name alone
  // would be wrong. The badge uses only the open ones; the menu links to this.
  const prByBranch = useMemo(() => {
    const map = new Map<string, PullRequestInfo>()
    for (const pr of pullRequests) {
      if (!pr.isCrossRepo && !map.has(pr.headBranch)) map.set(pr.headBranch, pr)
    }
    return map
  }, [pullRequests])

  // The compare URL for the "Create Pull Request" banner, or null when it
  // shouldn't show: only on a GitHub host, for a published branch (has an
  // upstream) that isn't the default branch and has no PR at all yet.
  const createPrUrl = useMemo(() => {
    // Wait until PRs have loaded — otherwise the banner flashes on every repo
    // open before we know whether the branch already has a PR.
    if (!prsLoaded) return null
    if (hostInfo?.provider !== 'github' || !hostInfo.webUrl) return null
    if (!branch || branch.detached || !branch.defaultBranch) return null
    const current = branch.current
    if (!current || current === branch.defaultBranch) return null
    // Any PR — open, merged or closed — means the branch's PR story is already
    // told (the menu's "Open Pull Request #N" reaches it), so don't nag to
    // create another. In particular, a just-merged branch must not reopen this.
    if (!sync?.upstream || prByBranch.has(current)) return null
    return compareUrl(hostInfo.webUrl, branch.defaultBranch, current)
  }, [hostInfo, branch, sync, prByBranch, prsLoaded])

  // Refresh PRs + CI when the window regains focus — the cheap way to catch a
  // build that finished while the user was away, without background polling.
  useEffect(() => {
    if (hostInfo?.provider !== 'github' || !repo) return
    const repoPath = repo.path
    const onFocus = () => loadGithubData(repoPath)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [hostInfo, repo, loadGithubData])

  // While the window is focused AND a check is still running, poll every 30s so
  // a pending dot turns green/red on its own. The moment nothing is pending the
  // effect re-runs with no timer, so it's silent whenever CI is settled.
  useEffect(() => {
    if (hostInfo?.provider !== 'github' || !repo) return
    if (!pullRequests.some((pr) => pr.checks === 'pending')) return
    const repoPath = repo.path
    const timer = setInterval(() => {
      if (document.hasFocus()) loadGithubData(repoPath)
    }, 30_000)
    return () => clearInterval(timer)
  }, [hostInfo, repo, pullRequests, loadGithubData])

  return { unpushedRef, prByBranch, createPrUrl, loadGithubData, resetGithub }
}
