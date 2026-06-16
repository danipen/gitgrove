import { describe, expect, it } from 'bun:test'

import {
  type AvatarLookupStore,
  fetchUserAvatarUrl,
  lookupAvatarUrl,
  searchUserAvatarUrl
} from './avatar'
import type { FetchLike } from './github'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const fetchReturning =
  (status: number, body: unknown): FetchLike =>
  async () =>
    jsonResponse(status, body)

const account = {
  id: 'github.com/daniel',
  provider: 'github' as const,
  host: 'github.com',
  login: 'daniel',
  name: null,
  email: null,
  scopes: [],
  persisted: true
}

const storeWith = (accounts = [account], token: string | null = 'tok'): AvatarLookupStore => ({
  listAccounts: () => accounts,
  getTokenForHost: () => token
})

describe('searchUserAvatarUrl', () => {
  it('returns the first matching avatar url', async () => {
    const fetchImpl = fetchReturning(200, {
      items: [{ avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4' }]
    })
    expect(await searchUserAvatarUrl('github.com', 'tok', 'a@b.com', fetchImpl)).toEqual({
      ok: true,
      url: 'https://avatars.githubusercontent.com/u/42?v=4'
    })
  })

  it('reports a definite miss when no users match', async () => {
    const fetchImpl = fetchReturning(200, { items: [] })
    expect(await searchUserAvatarUrl('github.com', 'tok', 'a@b.com', fetchImpl)).toEqual({
      ok: true,
      url: null
    })
  })

  it('treats an unsearchable query (422) as a definite miss', async () => {
    const fetchImpl = fetchReturning(422, { message: 'Validation Failed' })
    expect(await searchUserAvatarUrl('github.com', 'tok', 'odd', fetchImpl)).toEqual({
      ok: true,
      url: null
    })
  })

  it('flags rate limiting (403) as transient, never a miss', async () => {
    const fetchImpl = fetchReturning(403, { message: 'rate limited' })
    expect(await searchUserAvatarUrl('github.com', 'tok', 'a@b.com', fetchImpl)).toEqual({
      ok: false,
      url: null
    })
  })

  it('flags network failure as transient', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('offline')
    }
    expect(await searchUserAvatarUrl('github.com', 'tok', 'a@b.com', fetchImpl)).toEqual({
      ok: false,
      url: null
    })
  })

  it('queries the host API with the email scoped to the email field', async () => {
    let requested = ''
    const fetchImpl: FetchLike = async (url) => {
      requested = url
      return jsonResponse(200, { items: [] })
    }
    await searchUserAvatarUrl('github.com', 'tok', 'a+b@c.com', fetchImpl)
    expect(requested).toBe(
      `https://api.github.com/search/users?q=${encodeURIComponent('a+b@c.com in:email')}&per_page=1`
    )
  })
})

describe('fetchUserAvatarUrl', () => {
  it('returns the bot avatar url (the API points it at the App /in/ icon)', async () => {
    const fetchImpl = fetchReturning(200, {
      avatar_url: 'https://avatars.githubusercontent.com/in/15368?v=4'
    })
    expect(await fetchUserAvatarUrl('github.com', 'tok', 'github-actions[bot]', fetchImpl)).toEqual(
      { ok: true, url: 'https://avatars.githubusercontent.com/in/15368?v=4' }
    )
  })

  it('treats an unknown login (404) as a definite miss', async () => {
    const fetchImpl = fetchReturning(404, { message: 'Not Found' })
    expect(await fetchUserAvatarUrl('github.com', 'tok', 'gone[bot]', fetchImpl)).toEqual({
      ok: true,
      url: null
    })
  })

  it('flags rate limiting as transient', async () => {
    const fetchImpl = fetchReturning(403, { message: 'rate limited' })
    expect(await fetchUserAvatarUrl('github.com', 'tok', 'x[bot]', fetchImpl)).toEqual({
      ok: false,
      url: null
    })
  })
})

describe('lookupAvatarUrl', () => {
  it('is a definite miss with no connected accounts (cache cleared on change)', async () => {
    expect(await lookupAvatarUrl(storeWith([]), 'a@b.com')).toEqual({ ok: true, url: null })
  })

  it('is a definite miss for an empty email without touching the network', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('must not be called')
    }
    expect(await lookupAvatarUrl(storeWith(), '  ', fetchImpl)).toEqual({ ok: true, url: null })
  })

  it('is transient when the token cannot be decrypted', async () => {
    expect(await lookupAvatarUrl(storeWith([account], null), 'a@b.com')).toEqual({
      ok: false,
      url: null
    })
  })

  it('routes [bot] stealth emails to /users/<login>, not the email search', async () => {
    let requested = ''
    const fetchImpl: FetchLike = async (url) => {
      requested = url
      return jsonResponse(200, { avatar_url: 'https://avatars.githubusercontent.com/in/9?v=4' })
    }
    const result = await lookupAvatarUrl(
      storeWith(),
      '12345+claude[bot]@users.noreply.github.com',
      fetchImpl
    )
    expect(requested).toBe(`https://api.github.com/users/${encodeURIComponent('claude[bot]')}`)
    expect(result).toEqual({ ok: true, url: 'https://avatars.githubusercontent.com/in/9?v=4' })
  })

  it('prefers the github.com account over Enterprise ones', async () => {
    const ghes = { ...account, id: 'ghes.corp/d', host: 'ghes.corp' }
    let requested = ''
    const fetchImpl: FetchLike = async (url) => {
      requested = url
      return jsonResponse(200, { items: [] })
    }
    await lookupAvatarUrl(storeWith([ghes, account]), 'a@b.com', fetchImpl)
    expect(requested).toStartWith('https://api.github.com/')
  })
})
