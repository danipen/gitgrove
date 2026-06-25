// Looks up the pull requests for specific branches on a repo's GitHub remote,
// resolving the owner/repo from the remote URL and the token from the connected
// account. The renderer drives which branches it asks about and how often (the
// current branch on open/sync/focus, viewport branches as the switcher scrolls),
// so this module just answers one call cleanly.

import { parseOwnerRepo } from '@shared/git-host-urls'
import type { PullRequestLookup } from '@shared/types'
import { accountsStore } from '../accounts/cipher'
import { fetchPullRequestsForBranches } from '../accounts/github'
import { getRemoteWebUrl } from '../git/read'

const EMPTY: PullRequestLookup = { prs: [], totals: {} }

export async function listPullRequestsForBranches(
  repoPath: string,
  branches: string[]
): Promise<PullRequestLookup> {
  if (branches.length === 0) return EMPTY
  const webUrl = await getRemoteWebUrl(repoPath)
  if (!webUrl) return EMPTY
  const ownerRepo = parseOwnerRepo(webUrl)
  if (!ownerRepo) return EMPTY
  let host: string
  try {
    host = new URL(webUrl).host
  } catch {
    return EMPTY
  }
  // No connected account for the host → no token to call the API with → no PR
  // data. (This is also the gate: PR badges only appear once signed in.)
  const token = accountsStore().getTokenForHost(host)
  if (!token) return EMPTY
  try {
    return await fetchPullRequestsForBranches(
      host,
      token,
      ownerRepo.owner,
      ownerRepo.repo,
      branches
    )
  } catch {
    // Transient failure: hand back nothing and let the renderer keep its
    // last-known badges (it only overwrites its cache on a successful fetch).
    return EMPTY
  }
}
