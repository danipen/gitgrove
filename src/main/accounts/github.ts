// GitHub provider: browser device-flow OAuth and profile lookup, for both
// github.com and GitHub Enterprise Server. Device flow needs only a public
// client ID — no embedded secret, no callback URL scheme — and 2FA/passkeys
// happen in the user's browser where they already live.
//
// Endpoints (same paths on GHES, on the instance's host):
//   POST /login/device/code          → user code + device code + interval
//   POST /login/oauth/access_token   → poll with the device code
// Everything here is injectable (fetch, sleep) so tests run with canned
// responses — no sockets, no timers, no flakiness.

import { normalizeHost } from '@shared/git-hosts'
import type { AccountErrorCode, RemoteRepo } from '@shared/types'

/**
 * Scopes GitGrove asks for: `repo` (read/write private repos over HTTPS),
 * `workflow` (without it, pushes touching .github/workflows are rejected),
 * `read:user` + `user:email` (profile + email for the commit identity).
 */
export const GITHUB_OAUTH_SCOPES = ['repo', 'workflow', 'read:user', 'user:email']

/**
 * The GitGrove OAuth app on github.com, device flow enabled. Client IDs are
 * public by design (GitHub Desktop ships its own in the open) — only client
 * *secrets* must never be embedded, and device flow needs none. The env var
 * lets a fork or dev build swap in its own app.
 */
export const GITHUB_COM_CLIENT_ID = process.env.GITGROVE_OAUTH_CLIENT_ID ?? 'Ov23li5XRFKiFiHU1ogA'

/** Sign-in failures the UI knows how to phrase, carried as stable codes. */
export class AccountAuthError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(`account sign-in failed: ${code}`)
    this.name = 'AccountAuthError'
  }
}

/** Browser-facing base URL (OAuth pages live on the web host, not the API). */
export function webBaseUrl(host: string): string {
  return `https://${normalizeHost(host)}`
}

/**
 * REST base: github.com uses api.github.com, GHE.com data residency uses an
 * api. prefix, self-hosted GHES serves the API under /api/v3 (the GitHub
 * Desktop normalization rules).
 */
export function apiBaseUrl(host: string): string {
  const h = normalizeHost(host)
  if (h === 'github.com') return 'https://api.github.com'
  if (h.endsWith('.ghe.com')) return `https://api.${h}`
  return `https://${h}/api/v3`
}

/** What POST /login/device/code grants. */
export interface DeviceCodeGrant {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresInSec: number
  intervalSec: number
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

async function postForm(
  url: string,
  body: Record<string, string>,
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  } catch {
    if (signal?.aborted) throw new AccountAuthError('cancelled')
    throw new AccountAuthError('network')
  }
  // GitHub answers device-flow errors as 200 + {error}; non-OK here means the
  // endpoint itself is wrong (no such client/app on this host, proxy page…).
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    /* non-JSON body falls through to the !ok / shape checks below */
  }
  if (!response.ok && (response.status === 404 || response.status === 422)) {
    throw new AccountAuthError('bad-client-id')
  }
  if (!response.ok) throw new AccountAuthError('network')
  return (json ?? {}) as Record<string, unknown>
}

export async function requestDeviceCode(
  host: string,
  clientId: string,
  fetchImpl: FetchLike = fetch
): Promise<DeviceCodeGrant> {
  const json = await postForm(
    `${webBaseUrl(host)}/login/device/code`,
    { client_id: clientId, scope: GITHUB_OAUTH_SCOPES.join(' ') },
    fetchImpl
  )
  if (typeof json.error === 'string') throw new AccountAuthError('bad-client-id')
  const { device_code, user_code, verification_uri, expires_in, interval } = json
  if (typeof device_code !== 'string' || typeof user_code !== 'string') {
    throw new AccountAuthError('bad-client-id')
  }
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: typeof verification_uri === 'string' ? verification_uri : '',
    expiresInSec: typeof expires_in === 'number' ? expires_in : 900,
    intervalSec: typeof interval === 'number' ? interval : 5
  }
}

export interface PollOptions {
  signal?: AbortSignal
  fetchImpl?: FetchLike
  /** Injectable wait so tests poll instantly. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Poll the token endpoint until the user authorizes in the browser. Honors
 * the server's pacing: waits `interval` between attempts and adds 5s when
 * told to slow down — polling faster only earns rate-limit errors.
 */
export async function pollForAccessToken(
  host: string,
  clientId: string,
  grant: DeviceCodeGrant,
  opts: PollOptions = {}
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? realSleep
  // Belt and braces: github reports expired_token itself, but a misbehaving
  // server must not be able to keep us polling forever.
  const deadline = Date.now() + grant.expiresInSec * 1000
  let intervalSec = grant.intervalSec
  for (;;) {
    await sleep(intervalSec * 1000)
    if (opts.signal?.aborted) throw new AccountAuthError('cancelled')
    if (Date.now() > deadline) throw new AccountAuthError('expired')
    const json = await postForm(
      `${webBaseUrl(host)}/login/oauth/access_token`,
      {
        client_id: clientId,
        device_code: grant.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      },
      fetchImpl,
      opts.signal
    )
    if (typeof json.access_token === 'string') return json.access_token
    switch (json.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        intervalSec += 5
        continue
      case 'expired_token':
        throw new AccountAuthError('expired')
      case 'access_denied':
        throw new AccountAuthError('access-denied')
      default:
        // unrecognized_client / incorrect_client_credentials / device_flow_disabled
        throw new AccountAuthError('bad-client-id')
    }
  }
}

/** Profile of the signed-in user, plus the scopes the token actually has. */
export interface GitHubProfile {
  login: string
  name: string | null
  email: string | null
  scopes: string[]
}

/**
 * Resolve who a token belongs to (also how pasted tokens are validated). The
 * primary email is fetched separately because /user only exposes the public
 * one; a missing email is fine — the identity prefill just stays empty.
 */
export async function fetchProfile(
  host: string,
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<GitHubProfile> {
  const api = apiBaseUrl(host)
  const get = async (path: string): Promise<Response> => {
    try {
      return await fetchImpl(`${api}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      })
    } catch {
      throw new AccountAuthError('network')
    }
  }
  const userResponse = await get('/user')
  if (userResponse.status === 401 || userResponse.status === 403) {
    throw new AccountAuthError('bad-token')
  }
  if (!userResponse.ok) throw new AccountAuthError('network')
  const user = (await userResponse.json()) as Record<string, unknown>
  if (typeof user.login !== 'string') throw new AccountAuthError('bad-token')
  // Classic-token scopes are reported on every API response; fine-grained
  // PATs have none — an empty list is normal there, not an error.
  const scopes = (userResponse.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  let email = typeof user.email === 'string' ? user.email : null
  if (!email) {
    // Needs user:email; pasted tokens may lack it — degrade to no email.
    const emailsResponse = await get('/user/emails').catch(() => null)
    if (emailsResponse?.ok) {
      const emails = (await emailsResponse.json()) as Array<{
        email: string
        primary: boolean
        verified: boolean
      }>
      email = (emails.find((e) => e.primary) ?? emails.find((e) => e.verified))?.email ?? null
    }
  }
  return {
    login: user.login,
    name: typeof user.name === 'string' ? user.name : null,
    email,
    scopes
  }
}

/**
 * The `rel="next"` link out of a paginated response's `Link` header, or null
 * at the last page. GitHub paginates `/user/repos` this way; following the
 * header (rather than counting `?page=`) is the documented, future-proof walk.
 * Pure + exported for tests.
 */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return null
}

/**
 * Map one repo object from the GitHub REST API to a RemoteRepo, or null when
 * it's unusable (no owner — a repo whose owner was deleted, which the API can
 * still return). `host` is the account's host so the id and clone URL stay
 * consistent with the connected account, not whatever the API echoes back.
 */
export function parseRepo(value: unknown, host: string): RemoteRepo | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const owner = (r.owner as Record<string, unknown> | undefined)?.login
  if (typeof owner !== 'string' || typeof r.name !== 'string') return null
  const cloneUrl =
    typeof r.clone_url === 'string' ? r.clone_url : `https://${host}/${owner}/${r.name}.git`
  const pushed = typeof r.pushed_at === 'string' ? Date.parse(r.pushed_at) : NaN
  return {
    id: `${host}/${owner}/${r.name}`,
    host,
    owner,
    name: r.name,
    fullName: typeof r.full_name === 'string' ? r.full_name : `${owner}/${r.name}`,
    cloneUrl,
    private: r.private === true,
    fork: r.fork === true,
    archived: r.archived === true,
    description: typeof r.description === 'string' ? r.description : null,
    pushedAt: Number.isNaN(pushed) ? 0 : pushed
  }
}

/** Bounds a runaway walk — 10 pages × 100 is more repos than any picker needs. */
const MAX_REPO_PAGES = 10

/**
 * Every repository the token can clone — owned, collaborator and org repos —
 * most recently pushed first. Walks `/user/repos` page by page via the Link
 * header; auth/network failures surface as AccountAuthError (the IPC layer
 * turns them into a human message the picker shows with a retry).
 */
export async function fetchRepositories(
  host: string,
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<RemoteRepo[]> {
  const params = 'per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'
  let url: string | null = `${apiBaseUrl(host)}/user/repos?${params}`
  const repos: RemoteRepo[] = []
  for (let pageCount = 0; url && pageCount < MAX_REPO_PAGES; pageCount++) {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      })
    } catch {
      throw new AccountAuthError('network')
    }
    if (response.status === 401 || response.status === 403) {
      throw new AccountAuthError('bad-token')
    }
    if (!response.ok) throw new AccountAuthError('network')
    const items = (await response.json().catch(() => null)) as unknown
    if (!Array.isArray(items)) break
    for (const raw of items) {
      const repo = parseRepo(raw, host)
      if (repo) repos.push(repo)
    }
    url = nextPageUrl(response.headers.get('link'))
  }
  return repos.sort((a, b) => b.pushedAt - a.pushedAt)
}
