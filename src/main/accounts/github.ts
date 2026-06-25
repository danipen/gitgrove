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
import type {
  AccountErrorCode,
  PullRequestChecks,
  PullRequestInfo,
  PullRequestState,
  RemoteRepo
} from '@shared/types'

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

/**
 * GraphQL endpoint: github.com and GHE.com data residency expose it under the
 * `api.` host, self-hosted GHES serves it at `/api/graphql` (not under the
 * REST `/api/v3` prefix) — the same host-shape split as apiBaseUrl.
 */
export function graphqlUrl(host: string): string {
  const h = normalizeHost(host)
  if (h === 'github.com') return 'https://api.github.com/graphql'
  if (h.endsWith('.ghe.com')) return `https://api.${h}/graphql`
  return `https://${h}/api/graphql`
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
 * The affiliations we list, each fetched as its own paginated stream. Fetching
 * them separately — rather than `affiliation=owner,collaborator,organization_member`
 * in a single call — is what keeps the per-affiliation page cap from dropping
 * the user's own repositories behind a flood of recently-pushed org repos: a
 * combined, pushed-sorted, capped list silently omits a user's older personal
 * repos when they belong to busy organizations (the GitHub Desktop approach).
 */
const REPO_AFFILIATIONS = ['owner', 'collaborator', 'organization_member']

/** Walk one `/user/repos` query page by page via the Link header. */
async function walkRepoPages(
  host: string,
  token: string,
  query: string,
  fetchImpl: FetchLike,
  onPageRepos: (repos: RemoteRepo[]) => void
): Promise<void> {
  let url: string | null = `${apiBaseUrl(host)}/user/repos?${query}`
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
    const pageRepos: RemoteRepo[] = []
    for (const raw of items) {
      const repo = parseRepo(raw, host)
      if (repo) pageRepos.push(repo)
    }
    if (pageRepos.length) onPageRepos(pageRepos)
    url = nextPageUrl(response.headers.get('link'))
  }
}

/**
 * Every repository the token can clone — owned, collaborator and org repos,
 * most recently pushed first. Each affiliation is walked concurrently (see
 * REPO_AFFILIATIONS) and merged, de-duplicated by id; auth/network failures
 * surface as AccountAuthError (the IPC layer turns them into a human message
 * the picker shows with a retry).
 *
 * `onPage` is invoked with each batch of newly-seen repos the moment it parses,
 * so callers can show results within a second instead of after the whole walk.
 */
export async function fetchRepositories(
  host: string,
  token: string,
  fetchImpl: FetchLike = fetch,
  onPage?: (repos: RemoteRepo[]) => void
): Promise<RemoteRepo[]> {
  const byId = new Map<string, RemoteRepo>()
  const collect = (repos: RemoteRepo[]) => {
    // A repo can appear under more than one affiliation — emit each only once.
    const fresh = repos.filter((r) => !byId.has(r.id))
    for (const r of fresh) byId.set(r.id, r)
    if (fresh.length && onPage) onPage(fresh)
  }
  await Promise.all(
    REPO_AFFILIATIONS.map((affiliation) =>
      walkRepoPages(
        host,
        token,
        `per_page=100&sort=pushed&affiliation=${affiliation}`,
        fetchImpl,
        collect
      )
    )
  )
  return [...byId.values()].sort((a, b) => b.pushedAt - a.pushedAt)
}

/**
 * Run a GraphQL query with the account token and return its `data`. GraphQL
 * reports problems as 200 + `{errors}` with a null/partial `data`, so those are
 * surfaced as well: auth failures as bad-token, anything else as network. The
 * caller degrades to "no PR data" rather than blocking the UI, so a precise
 * error taxonomy isn't needed here.
 */
async function graphqlQuery<T>(
  host: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: FetchLike = fetch
): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(graphqlUrl(host), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ query, variables })
    })
  } catch {
    throw new AccountAuthError('network')
  }
  if (response.status === 401 || response.status === 403) throw new AccountAuthError('bad-token')
  if (!response.ok) throw new AccountAuthError('network')
  const json = (await response.json().catch(() => null)) as { data?: T; errors?: unknown } | null
  if (!json || json.errors || json.data == null) throw new AccountAuthError('network')
  return json.data
}

/**
 * Collapse a GraphQL `statusCheckRollup.state` into our three-state CI signal.
 * The rollup is GitHub's own server-side reduction of every status + check run
 * on the head commit, so the precedence (any failure → red, all passing →
 * green, else still running) is already applied. `EXPECTED` means a required
 * check hasn't reported yet — still pending. Null/absent means no checks ran.
 */
function rollupChecks(node: Record<string, unknown>): PullRequestChecks | null {
  const commits = (node.commits as { nodes?: unknown[] } | undefined)?.nodes
  const head =
    Array.isArray(commits) && commits[0] && typeof commits[0] === 'object' ? commits[0] : null
  const commit = head ? (head as Record<string, unknown>).commit : null
  const rollup =
    commit && typeof commit === 'object'
      ? (commit as Record<string, unknown>).statusCheckRollup
      : null
  const state =
    rollup && typeof rollup === 'object' ? (rollup as Record<string, unknown>).state : null
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return null
  }
}

/** GraphQL's PullRequestState enum (OPEN/CLOSED/MERGED) → our lowercase form. */
function prState(value: unknown): PullRequestState {
  return value === 'MERGED' ? 'merged' : value === 'CLOSED' ? 'closed' : 'open'
}

/**
 * Map one pull request node from the GraphQL API to a PullRequestInfo, or null
 * when it's unusable (no number/head ref). `checks` carries the rolled-up CI
 * state of the head commit, or null when the query didn't ask for it / no
 * checks ran.
 */
export function parsePullRequest(node: unknown): PullRequestInfo | null {
  if (!node || typeof node !== 'object') return null
  const n = node as Record<string, unknown>
  if (typeof n.number !== 'number' || typeof n.headRefName !== 'string') return null
  return {
    number: n.number,
    state: prState(n.state),
    title: typeof n.title === 'string' ? n.title : '',
    url: typeof n.url === 'string' ? n.url : '',
    draft: n.isDraft === true,
    headBranch: n.headRefName,
    baseBranch: typeof n.baseRefName === 'string' ? n.baseRefName : '',
    isCrossRepo: n.isCrossRepository === true,
    checks: rollupChecks(n)
  }
}

// The PR fields the pill/menu render — shared by every per-branch alias below.
const PR_FIELDS = `number state title url isDraft headRefName baseRefName isCrossRepository
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`

// How many branches we ask about in one round trip. We query PRs *by head ref*
// rather than pulling the repo's recent PRs and matching client-side: on a busy
// monorepo the "recent 100" window is only hours wide, so a branch's older PR
// falls out of it entirely. A `headRefName` lookup is activity-independent — it
// finds the PR no matter how long ago it was touched. Each alias asks `first: 1`
// (the branch's most recent PR, any state), so a batch is cheap; we still cap it
// so a 25k-branch repo builds bounded requests instead of one monster query.
const BRANCH_BATCH = 50

/**
 * Build an aliased GraphQL query asking for each branch's most recent PR. Branch
 * names are passed as `$b{i}` variables (never interpolated) so a branch like
 * `"); }` can't break out of the query.
 */
function branchPullRequestsQuery(count: number): string {
  const params = Array.from({ length: count }, (_, i) => `$b${i}: String!`).join(', ')
  const aliases = Array.from(
    { length: count },
    (_, i) =>
      `b${i}: pullRequests(headRefName: $b${i}, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }`
  ).join('\n    ')
  return `query($owner: String!, $name: String!, ${params}) {
  repository(owner: $owner, name: $name) {
    ${aliases}
  }
}`
}

/**
 * The most recent pull request (any state) for each of `branches` on
 * `owner/repo`, looked up by head ref so it's found regardless of repo activity.
 * Returns only branches that actually have a PR — the caller knows which
 * branches it asked about, so a branch absent here is "checked, no PR" (it
 * caches that and won't re-ask). Batched into bounded round trips; auth/network
 * failures throw AccountAuthError (the caller keeps its last-known badges).
 */
export async function fetchPullRequestsForBranches(
  host: string,
  token: string,
  owner: string,
  repo: string,
  branches: string[],
  fetchImpl: FetchLike = fetch
): Promise<PullRequestInfo[]> {
  const found: PullRequestInfo[] = []
  for (let start = 0; start < branches.length; start += BRANCH_BATCH) {
    const chunk = branches.slice(start, start + BRANCH_BATCH)
    const variables: Record<string, string> = { owner, name: repo }
    chunk.forEach((branch, i) => {
      variables[`b${i}`] = branch
    })
    const data = await graphqlQuery<{
      repository: Record<string, { nodes: unknown[] }> | null
    }>(host, token, branchPullRequestsQuery(chunk.length), variables, fetchImpl)
    const repoData = data.repository
    if (!repoData) continue
    chunk.forEach((_, i) => {
      const pr = parsePullRequest(repoData[`b${i}`]?.nodes?.[0])
      if (pr) found.push(pr)
    })
  }
  return found
}
