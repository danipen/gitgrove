// Lists the open pull requests for a repo's GitHub remote, resolving the
// owner/repo from the remote URL and the token from the connected account. The
// renderer drives how often this is called (on repo open, after sync, on focus,
// and while checks run); this module just answers one call cleanly.

import { parseOwnerRepo } from '@shared/git-host-urls'
import type { PullRequestInfo } from '@shared/types'
import { accountsStore } from '../accounts/cipher'
import { fetchPullRequests } from '../accounts/github'
import { getRemoteWebUrl } from '../git/read'

// Last successful result per repo. A transient fetch failure hands this back
// instead of an empty list, so PR badges don't flicker away on a network blip.
const lastByRepo = new Map<string, PullRequestInfo[]>()

export async function listPullRequests(repoPath: string): Promise<PullRequestInfo[]> {
  const webUrl = await getRemoteWebUrl(repoPath)
  if (!webUrl) return []
  const ownerRepo = parseOwnerRepo(webUrl)
  if (!ownerRepo) return []
  let host: string
  try {
    host = new URL(webUrl).host
  } catch {
    return []
  }
  // No connected account for the host → no token to call the API with → no PR
  // data. (This is also the gate: PR badges only appear once signed in.)
  const token = accountsStore().getTokenForHost(host)
  if (!token) return []
  try {
    const prs = await fetchPullRequests(host, token, ownerRepo.owner, ownerRepo.repo)
    lastByRepo.set(repoPath, prs)
    return prs
  } catch {
    return lastByRepo.get(repoPath) ?? []
  }
}
