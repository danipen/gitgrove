// Email → avatar resolution through the connected account's API. This is the
// "exact hits, detectable misses" half of the renderer's avatar chain: GitHub
// answers with JSON (a user, or none) instead of an image, so — unlike the
// public avatars.githubusercontent.com/u/e endpoint, which serves an
// identicon for unknown emails — a miss is detectable and the renderer can
// fall back to Gravatar and then initials.

import { isGitHubDotCom } from '@shared/git-hosts'
import type { AvatarLookupResult } from '@shared/types'
import { apiBaseUrl, type FetchLike } from './github'
import type { AccountsStore } from './store'

/** The slice of AccountsStore the lookup needs (keeps tests dependency-free). */
export type AvatarLookupStore = Pick<AccountsStore, 'listAccounts' | 'getTokenForHost'>

// A GitHub App machine user's stealth email. Bots need their own lookup
// route: the email search can't find them (no public profile email), but
// GET /users/<login> answers with an avatar_url that already points at the
// App's /in/… icon — the recognizable one (their /u/ avatar is an identicon).
const BOT_STEALTH_EMAIL = /^(?:\d+\+)?([^@]*\[bot\])@users\.noreply\.github\.com$/

/**
 * Resolve `email` to an avatar URL using the best connected account —
 * github.com when connected (the universal identity host), otherwise the
 * first account (GHES). No account at all is a definite miss, not an error:
 * the renderer caches it and clears that cache on accountsChanged.
 */
export async function lookupAvatarUrl(
  store: AvatarLookupStore,
  email: string,
  fetchImpl: FetchLike = fetch
): Promise<AvatarLookupResult> {
  const trimmed = email.trim()
  if (!trimmed) return { ok: true, url: null }
  const accounts = store.listAccounts()
  const account = accounts.find((a) => isGitHubDotCom(a.host)) ?? accounts[0]
  if (!account) return { ok: true, url: null }
  const token = store.getTokenForHost(account.host)
  // An undecryptable token is transient (keyring hiccup) — never cache as a miss.
  if (!token) return { ok: false, url: null }
  const bot = BOT_STEALTH_EMAIL.exec(trimmed.toLowerCase())
  if (bot) return fetchUserAvatarUrl(account.host, token, bot[1], fetchImpl)
  return searchUserAvatarUrl(account.host, token, trimmed, fetchImpl)
}

/** GET /users/<login> — the only API route that resolves [bot] accounts. */
export async function fetchUserAvatarUrl(
  host: string,
  token: string,
  login: string,
  fetchImpl: FetchLike = fetch
): Promise<AvatarLookupResult> {
  let response: Response
  try {
    response = await fetchImpl(`${apiBaseUrl(host)}/users/${encodeURIComponent(login)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
  } catch {
    return { ok: false, url: null }
  }
  // 404 = no such bot on this host — a definite miss.
  if (response.status === 404) return { ok: true, url: null }
  if (!response.ok) return { ok: false, url: null }
  const json = (await response.json().catch(() => null)) as { avatar_url?: unknown } | null
  return { ok: true, url: typeof json?.avatar_url === 'string' ? json.avatar_url : null }
}

/**
 * Ask the host's user search who owns `email`. Only finds users whose email
 * is public on their profile — that's the API's limit, GitHub Desktop lives
 * with the same one — so a miss here still flows on to Gravatar.
 */
export async function searchUserAvatarUrl(
  host: string,
  token: string,
  email: string,
  fetchImpl: FetchLike = fetch
): Promise<AvatarLookupResult> {
  const query = encodeURIComponent(`${email} in:email`)
  let response: Response
  try {
    response = await fetchImpl(`${apiBaseUrl(host)}/search/users?q=${query}&per_page=1`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
  } catch {
    return { ok: false, url: null }
  }
  // 422 = the query itself is unsearchable (malformed email) — a definite miss.
  if (response.status === 422) return { ok: true, url: null }
  // 401/403/429/5xx: auth or rate-limit trouble — transient, retry later.
  if (!response.ok) return { ok: false, url: null }
  const json = (await response.json().catch(() => null)) as {
    items?: Array<{ avatar_url?: unknown }>
  } | null
  const url = json?.items?.[0]?.avatar_url
  return { ok: true, url: typeof url === 'string' ? url : null }
}
