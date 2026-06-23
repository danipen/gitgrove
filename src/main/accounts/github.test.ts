import { describe, expect, test } from 'bun:test'
import {
  AccountAuthError,
  apiBaseUrl,
  type DeviceCodeGrant,
  fetchProfile,
  fetchRepositories,
  nextPageUrl,
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

  test('walks every page via the Link header and sorts most-recent first', async () => {
    const { impl, calls } = scriptedFetch([
      {
        json: [repoJson('older', 'me', '2026-01-01T00:00:00Z')],
        headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' }
      },
      { json: [repoJson('newer', 'me', '2026-06-01T00:00:00Z')] }
    ])
    const repos = await fetchRepositories('github.com', 'tok', impl)
    expect(repos.map((r) => r.name)).toEqual(['newer', 'older'])
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('https://api.github.com/user/repos?per_page=100')
    expect(calls[0].url).toContain('affiliation=owner,collaborator,organization_member')
  })

  test('a 401 surfaces as bad-token', async () => {
    const { impl } = scriptedFetch([{ status: 401, json: { message: 'Bad credentials' } }])
    expect(await code(fetchRepositories('github.com', 'nope', impl))).toBe('bad-token')
  })
})
