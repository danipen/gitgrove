// Resolving a repo's remote URL — both the browsable https form (for "View on
// the web") and the raw clone URL git stores (remembered for "Clone Again").

import { runGit } from './core'

/**
 * Turn a git remote URL into a browsable https web URL, handling the three
 * forms git hands back: scp-like (`git@host:owner/repo.git`), `ssh://` /
 * `git://`, and plain http(s). Returns null when the input can't be turned into
 * something a browser opens (e.g. a local path remote). Pure + exported so it
 * can be unit-tested without a real repo.
 */
export function toWebUrl(remote: string): string | null {
  let url = remote.trim()
  if (!url) return null
  // scp-like: git@github.com:owner/repo.git  →  https://github.com/owner/repo
  const scp = url.match(/^[\w.+-]+@([^:/]+):(.+)$/)
  if (scp) {
    url = `https://${scp[1]}/${scp[2]}`
  } else if (url.startsWith('ssh://')) {
    // ssh://git@host[:port]/owner/repo → drop creds + port, force https
    url = url.replace(/^ssh:\/\/(?:[^@/]+@)?/, 'https://').replace(/^(https:\/\/[^/]+):\d+/, '$1')
  } else if (url.startsWith('git://')) {
    url = `https://${url.slice('git://'.length)}`
  } else if (url.startsWith('http://')) {
    url = `https://${url.slice('http://'.length)}`
  } else if (!url.startsWith('https://')) {
    return null
  }
  url = url.replace(/\.git$/, '')
  // Sanity-check the result looks like https://host/path before handing it off.
  return /^https:\/\/[^/]+\/.+/.test(url) ? url : null
}

/**
 * Resolve the repo's remote to a browsable web URL, preferring `origin` and
 * falling back to the first configured remote. Returns null when the repo has
 * no remote or its URL can't be made browsable.
 */
export async function getRemoteWebUrl(repoPath: string): Promise<string | null> {
  const raw = await getRemoteCloneUrl(repoPath)
  return raw ? toWebUrl(raw) : null
}

/**
 * The repo's raw remote URL (origin, else the first configured remote), as git
 * stores it — kept verbatim (not made browsable) because it's what we'd hand
 * back to `git clone`. Used to remember a repo's origin for "Clone Again" after
 * its folder is gone. Null when the repo has no remote.
 */
export async function getRemoteCloneUrl(repoPath: string): Promise<string | null> {
  const readUrl = async (remote: string): Promise<string | null> => {
    try {
      return (await runGit(repoPath, ['remote', 'get-url', remote])).trim() || null
    } catch {
      return null
    }
  }
  const origin = await readUrl('origin')
  if (origin) return origin
  const first = (await runGit(repoPath, ['remote']).catch(() => ''))
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)[0]
  return first ? await readUrl(first) : null
}
