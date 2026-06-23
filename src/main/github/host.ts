// Resolves a repo's remote into what the renderer needs to offer GitHub-aware
// actions: the browsable web URL plus whether the host is a GitHub one we can
// build commit/branch/pull-request links for.
//
// A host counts as GitHub when it's github.com, a `*.ghe.com` data-residency
// host, or any host the user has a connected account on — that last case is how
// self-hosted GitHub Enterprise Server is recognized, since its hostname is
// otherwise indistinguishable from any other git server.

import { normalizeHost } from '@shared/git-hosts'
import type { RepoHostInfo } from '@shared/types'
import { accountsStore } from '../accounts/cipher'
import { getRemoteWebUrl } from '../git/read'

function isGitHubHost(host: string): boolean {
  const h = normalizeHost(host)
  if (h === 'github.com' || h.endsWith('.ghe.com')) return true
  return accountsStore().getAccountForHost(h) !== null
}

export async function getRepoHostInfo(repoPath: string): Promise<RepoHostInfo> {
  const webUrl = await getRemoteWebUrl(repoPath)
  if (!webUrl) return { webUrl: null, provider: null }
  let host: string
  try {
    host = new URL(webUrl).host
  } catch {
    return { webUrl, provider: null }
  }
  return { webUrl, provider: isGitHubHost(host) ? 'github' : null }
}
