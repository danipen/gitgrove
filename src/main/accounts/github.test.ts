import { describe, expect, test } from 'bun:test'
import {
  AccountAuthError,
  apiBaseUrl,
  type DeviceCodeGrant,
  type FetchLike,
  fetchProfile,
  fetchPullRequests,
  fetchRepositories,
  graphqlUrl,
  nextPageUrl,
  parsePullRequest,
  parseRepo,
  pollForAccessToken,
  requestDeviceCode,
  webBaseUrl
} from './github'

// All network behaviour is exercised through an injected fetch returning
// canned Responses — no sockets, no timers, nothing that can flake.

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> }

/** A fetch fake that pops one scripted reply per call and records requests. */
function scriptedFetch(replies: Reply[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : {} })
    const reply = replies.shift()
    if (!reply) throw new Error('scriptedFetch ran out of replies')
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...reply.headers }
    })
  }
  return { impl, calls }
}

const instantSleep = () => Promise.resolve()

const grant = (over: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant => ({
  deviceCode: 'dev-code',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresInSec: 900,
  intervalSec: 5,
  ...over
})

const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => (e instanceof AccountAuthError ? e.code : Promise.reject(e))
  )

describe('URL normalization', () => {
  test('github.com, ghe.com data residency and self-hosted GHES', () => {
    expect(apiBaseUrl('github.com')).toBe('https://api.github.com')
    expect(apiBaseUrl('Corp.ghe.com')).toBe('https://api.corp.ghe.com')
    expect(apiBaseUrl('github.corp.example')).toBe('https://github.corp.example/api/v3')
    expect(webBaseUrl('GitHub.Corp.Example')).toBe('https://github.corp.example')
  })
})

describe('requestDeviceCode', () => {
  test('parses a grant and posts the client id + scopes', async () => {
    const { impl, calls } = scriptedFetch([
      {
        json: {
          device_code: 'dc',
          user_code: 'WXYZ-9876',
          verification_uri: 'https://github.com/login/device',
          expires_in: 899,
          interval: 5
        }
      }
    ])
    const result = await requestDeviceCode('github.com', 'client-1', impl)
    expect(result.userCode).toBe('WXYZ-9876')
    expect(result.expiresInSec).toBe(899)
    expect(calls[0].url).toBe('https://github.com/login/device/code')
    expect(calls[0].body.client_id).toBe('client-1')
    expect(String(calls[0].body.scope)).toContain('repo')
  })

  test('an unknown client id on the host reads as bad-client-id', async () => {
    // GHES without a GitGrove OAuth app registered answers 404 here.
    const { impl } = scriptedFetch([{ status: 404, json: {} }])
    expect(await code(requestDeviceCode('ghe.corp.example', 'nope', impl))).toBe('bad-client-id')
  })
})

describe('pollForAccessToken', () => {
  test('keeps polling through authorization_pending until the token arrives', async () => {
    const { impl, calls } = scriptedFetch([
      { json: { error: 'authorization_pending' } },
      { json: { error: 'authorization_pending' } },
      { json: { access_token: 'gho_abc', token_type: 'bearer' } }
    ])
    const token = await pollForAccessToken('github.com', 'c', grant(), {
      fetchImpl: impl,
      sleep: instantSleep
    })
    expect(token).toBe('gho_abc')
    expect(calls).toHaveLength(3)
    expect(calls[0].body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
  })

  test('slow_down stretches the wait by 5s as the spec demands', async () => {
    const waits: number[] = []
    const { impl } = scriptedFetch([
      { json: { error: 'slow_down' } },
      { json: { access_token: 't' } }
    ])
    await pollForAccessToken('github.com', 'c', grant(), {
      fetchImpl: impl,
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      }
    })
    expect(waits).toEqual([5000, 10000])
  })

  test('denial, expiry and cancellation map to their codes', async () => {
    const denied = scriptedFetch([{ json: { error: 'access_denied' } }])
    expect(
      await code(
        pollForAccessToken('github.com', 'c', grant(), {
          fetchImpl: denied.impl,
          sleep: instantSleep
        })
      )
    ).toBe('access-denied')

    const expired = scriptedFetch([{ json: { error: 'expired_token' } }])
    expect(
      await code(
        pollForAccessToken('github.com', 'c', grant(), {
          fetchImpl: expired.impl,
          sleep: instantSleep
        })
      )
    ).toBe('expired')

    const aborted = new AbortController()
    aborted.abort()
    expect(
      await code(
        pollForAccessToken('github.com', 'c', grant(), {
          fetchImpl: scriptedFetch([]).impl,
          sleep: instantSleep,
          signal: aborted.signal
        })
      )
    ).toBe('cancelled')
  })
})

describe('fetchProfile', () => {
  test('reads login, name, scopes and the primary email', async () => {
    const { impl, calls } = scriptedFetch([
      {
        json: { login: 'octocat', name: 'The Octocat', email: null },
        headers: { 'x-oauth-scopes': 'repo, workflow, user:email' }
      },
      {
        json: [
          { email: 'oc@users.noreply.github.com', primary: false, verified: true },
          { email: 'octocat@github.com', primary: true, verified: true }
        ]
      }
    ])
    const profile = await fetchProfile('github.com', 'tok', impl)
    expect(profile).toEqual({
      login: 'octocat',
      name: 'The Octocat',
      email: 'octocat@github.com',
      scopes: ['repo', 'workflow', 'user:email']
    })
    expect(calls[0].url).toBe('https://api.github.com/user')
    expect(calls[1].url).toBe('https://api.github.com/user/emails')
  })

  test('a rejected token reads as bad-token; GHES hits /api/v3', async () => {
    const { impl, calls } = scriptedFetch([{ status: 401, json: { message: 'Bad credentials' } }])
    expect(await code(fetchProfile('ghe.corp.example', 'nope', impl))).toBe('bad-token')
    expect(calls[0].url).toBe('https://ghe.corp.example/api/v3/user')
  })

  test('an unreadable email list degrades to null, not failure', async () => {
    const { impl } = scriptedFetch([
      { json: { login: 'limited', name: null, email: null }, headers: {} },
      { status: 404, json: { message: 'Not Found' } }
    ])
    const profile = await fetchProfile('github.com', 'tok', impl)
    expect(profile.login).toBe('limited')
    expect(profile.email).toBeNull()
    expect(profile.scopes).toEqual([])
  })
})

describe('nextPageUrl', () => {
  test('extracts the rel="next" link, ignoring other rels', () => {
    const header =
      '<https://api.github.com/user/repos?page=2>; rel="next", ' +
      '<https://api.github.com/user/repos?page=5>; rel="last"'
    expect(nextPageUrl(header)).toBe('https://api.github.com/user/repos?page=2')
  })

  test('null/absent next means the last page', () => {
    expect(nextPageUrl(null)).toBeNull()
    expect(nextPageUrl('<https://api.github.com/user/repos?page=5>; rel="last"')).toBeNull()
  })
})

describe('parseRepo', () => {
  test('maps the API shape and pins host/clone URL to the account host', () => {
    const repo = parseRepo(
      {
        name: 'gitgrove',
        full_name: 'danipen/gitgrove',
        owner: { login: 'danipen' },
        clone_url: 'https://github.com/danipen/gitgrove.git',
        private: true,
        fork: false,
        archived: false,
        description: 'A git client',
        pushed_at: '2026-06-20T10:00:00Z'
      },
      'github.com'
    )
    expect(repo).toEqual({
      id: 'github.com/danipen/gitgrove',
      host: 'github.com',
      owner: 'danipen',
      name: 'gitgrove',
      fullName: 'danipen/gitgrove',
      cloneUrl: 'https://github.com/danipen/gitgrove.git',
      private: true,
      fork: false,
      archived: false,
      description: 'A git client',
      pushedAt: Date.parse('2026-06-20T10:00:00Z')
    })
  })

  test('drops an owner-less repo (deleted owner) rather than crash', () => {
    expect(parseRepo({ name: 'orphan', owner: {} }, 'github.com')).toBeNull()
    expect(parseRepo(null, 'github.com')).toBeNull()
  })
})

describe('fetchRepositories', () => {
  const repoJson = (name: string, owner = 'me', pushed = '2026-01-01T00:00:00Z') => ({
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner },
    clone_url: `https://github.com/${owner}/${name}.git`,
    pushed_at: pushed
  })

  /**
   * A fetch fake that routes by the `affiliation` query param (the three
   * affiliations are walked concurrently, so a shift queue would be racy) and
   * by `page`, honoring a `next` Link header for multi-page affiliations.
   */
  function affiliationFetch(pages: Record<string, Reply[]>): { impl: FetchLike; calls: string[] } {
    const calls: string[] = []
    const impl = async (url: string): Promise<Response> => {
      calls.push(url)
      const params = new URL(url).searchParams
      const affiliation = params.get('affiliation') ?? ''
      const page = Number(params.get('page') ?? '1')
      const reply = pages[affiliation]?.[page - 1] ?? { json: [] }
      return new Response(JSON.stringify(reply.json ?? []), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...reply.headers }
      })
    }
    return { impl, calls }
  }

  test('fetches each affiliation separately and merges, most-recent first', async () => {
    const { impl, calls } = affiliationFetch({
      owner: [{ json: [repoJson('mine', 'me', '2026-03-01T00:00:00Z')] }],
      collaborator: [{ json: [repoJson('shared', 'pal', '2026-06-01T00:00:00Z')] }],
      organization_member: [{ json: [repoJson('orgrepo', 'acme', '2026-01-01T00:00:00Z')] }]
    })
    const repos = await fetchRepositories('github.com', 'tok', impl)
    expect(repos.map((r) => r.name)).toEqual(['shared', 'mine', 'orgrepo'])
    // One walk per affiliation — the fix for owner repos getting crowded out.
    const affiliations = calls.map((u) => new URL(u).searchParams.get('affiliation')).sort()
    expect(affiliations).toEqual(['collaborator', 'organization_member', 'owner'])
  })

  test('de-duplicates a repo that appears under multiple affiliations', async () => {
    const { impl } = affiliationFetch({
      owner: [{ json: [repoJson('dup', 'me')] }],
      collaborator: [{ json: [repoJson('dup', 'me')] }],
      organization_member: [{ json: [] }]
    })
    const repos = await fetchRepositories('github.com', 'tok', impl)
    expect(repos.map((r) => r.id)).toEqual(['github.com/me/dup'])
  })

  test('paginates within an affiliation via the Link header', async () => {
    const { impl } = affiliationFetch({
      owner: [
        {
          json: [repoJson('p1', 'me')],
          headers: {
            link: '<https://api.github.com/user/repos?affiliation=owner&page=2>; rel="next"'
          }
        },
        { json: [repoJson('p2', 'me')] }
      ],
      collaborator: [{ json: [] }],
      organization_member: [{ json: [] }]
    })
    const repos = await fetchRepositories('github.com', 'tok', impl)
    expect(repos.map((r) => r.name).sort()).toEqual(['p1', 'p2'])
  })

  test('a 401 on any affiliation surfaces as bad-token', async () => {
    const { impl } = affiliationFetch({
      owner: [{ json: [repoJson('mine')] }],
      collaborator: [{ status: 401, json: { message: 'Bad credentials' } }],
      organization_member: [{ json: [] }]
    })
    expect(await code(fetchRepositories('github.com', 'nope', impl))).toBe('bad-token')
  })

  test('streams newly-seen repos to onPage as they arrive', async () => {
    const { impl } = affiliationFetch({
      owner: [{ json: [repoJson('a'), repoJson('dup')] }],
      collaborator: [{ json: [repoJson('dup')] }],
      organization_member: [{ json: [] }]
    })
    const streamed: string[] = []
    const all = await fetchRepositories('github.com', 'tok', impl, (repos) => {
      for (const r of repos) streamed.push(r.name)
    })
    // 'dup' is emitted once even though two affiliations return it.
    expect(streamed.sort()).toEqual(['a', 'dup'])
    expect(all).toHaveLength(2)
  })
})

describe('graphqlUrl', () => {
  test('github.com and GHES resolve to their GraphQL endpoints', () => {
    expect(graphqlUrl('github.com')).toBe('https://api.github.com/graphql')
    expect(graphqlUrl('octo.ghe.com')).toBe('https://api.octo.ghe.com/graphql')
    expect(graphqlUrl('github.example.com')).toBe('https://github.example.com/api/graphql')
  })
})

describe('parsePullRequest', () => {
  const node = {
    number: 7,
    state: 'OPEN',
    title: 'Add things',
    url: 'https://github.com/o/r/pull/7',
    isDraft: true,
    headRefName: 'feature/x',
    baseRefName: 'main',
    isCrossRepository: false
  }

  test('maps a GraphQL node to PullRequestInfo (checks left null)', () => {
    expect(parsePullRequest(node)).toEqual({
      number: 7,
      state: 'open',
      title: 'Add things',
      url: 'https://github.com/o/r/pull/7',
      draft: true,
      headBranch: 'feature/x',
      baseBranch: 'main',
      isCrossRepo: false,
      checks: null
    })
  })

  test('maps the lifecycle state (merged/closed/open, defaulting to open)', () => {
    expect(parsePullRequest({ ...node, state: 'MERGED' })?.state).toBe('merged')
    expect(parsePullRequest({ ...node, state: 'CLOSED' })?.state).toBe('closed')
    expect(parsePullRequest({ ...node, state: undefined })?.state).toBe('open')
  })

  test('returns null when number or head ref is missing', () => {
    expect(parsePullRequest({ ...node, number: undefined })).toBeNull()
    expect(parsePullRequest({ ...node, headRefName: undefined })).toBeNull()
    expect(parsePullRequest(null)).toBeNull()
  })

  const withRollup = (state: string | null) => ({
    ...node,
    commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] }
  })

  test('collapses the statusCheckRollup state into the CI signal', () => {
    expect(parsePullRequest(withRollup('SUCCESS'))?.checks).toBe('success')
    expect(parsePullRequest(withRollup('FAILURE'))?.checks).toBe('failure')
    expect(parsePullRequest(withRollup('ERROR'))?.checks).toBe('failure')
    expect(parsePullRequest(withRollup('PENDING'))?.checks).toBe('pending')
    expect(parsePullRequest(withRollup('EXPECTED'))?.checks).toBe('pending')
  })

  test('checks is null when no rollup is present (no checks configured)', () => {
    expect(parsePullRequest(withRollup(null))?.checks).toBeNull()
    expect(parsePullRequest({ ...node, commits: { nodes: [] } })?.checks).toBeNull()
    expect(parsePullRequest(node)?.checks).toBeNull()
  })
})

describe('fetchPullRequests', () => {
  const prNode = (over: Record<string, unknown> = {}) => ({
    number: 1,
    title: 'PR',
    url: 'https://github.com/o/r/pull/1',
    isDraft: false,
    headRefName: 'feature',
    baseRefName: 'main',
    isCrossRepository: false,
    ...over
  })

  test('parses open PRs and posts to the GraphQL endpoint', async () => {
    const { impl, calls } = scriptedFetch([
      {
        json: {
          data: {
            repository: {
              pullRequests: {
                nodes: [prNode(), prNode({ number: 2, headRefName: 'other', isDraft: true })]
              }
            }
          }
        }
      }
    ])
    const prs = await fetchPullRequests('github.com', 'tok', 'o', 'r', impl)
    expect(calls[0].url).toBe('https://api.github.com/graphql')
    expect(calls[0].body).toMatchObject({ variables: { owner: 'o', name: 'r' } })
    expect(prs.map((p) => ({ n: p.number, head: p.headBranch, draft: p.draft }))).toEqual([
      { n: 1, head: 'feature', draft: false },
      { n: 2, head: 'other', draft: true }
    ])
  })

  test('treats a missing repository (null data branch) as no PRs', async () => {
    const { impl } = scriptedFetch([{ json: { data: { repository: null } } }])
    expect(await fetchPullRequests('github.com', 'tok', 'o', 'r', impl)).toEqual([])
  })

  test('surfaces a 401 as bad-token', async () => {
    const { impl } = scriptedFetch([{ status: 401, json: { message: 'Bad credentials' } }])
    expect(await code(fetchPullRequests('github.com', 'nope', 'o', 'r', impl))).toBe('bad-token')
  })

  test('treats GraphQL errors as a network failure', async () => {
    const { impl } = scriptedFetch([{ json: { errors: [{ message: 'NOT_FOUND' }] } }])
    expect(await code(fetchPullRequests('github.com', 'tok', 'o', 'r', impl))).toBe('network')
  })
})
