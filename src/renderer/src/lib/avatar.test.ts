import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  avatarColor,
  githubEmailAvatarUrl,
  gravatarUrl,
  initials,
  withAvatarSize
} from './avatar'

describe('gravatarUrl', () => {
  it('hashes the email with SHA-256 and builds the avatar URL', async () => {
    const email = 'Daniel.Penalba@Unity3D.com'
    const expectedHash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')

    const url = await gravatarUrl(email)
    expect(url).toBe(`https://gravatar.com/avatar/${expectedHash}?s=80&d=404`)
  })

  it('honours a custom size', async () => {
    const url = await gravatarUrl('a@b.com', 160)
    expect(url).toContain('?s=160&d=404')
  })

  it('treats differently-cased / padded emails as the same identity', async () => {
    const a = await gravatarUrl(' user@example.com ')
    const b = await gravatarUrl('USER@EXAMPLE.COM')
    expect(a).toBe(b)
  })
})

describe('githubEmailAvatarUrl', () => {
  it('resolves new-style stealth emails by user id', () => {
    expect(githubEmailAvatarUrl('41898282+claude[bot]@users.noreply.github.com', 64)).toBe(
      'https://avatars.githubusercontent.com/u/41898282?s=64&v=4'
    )
  })

  it('resolves legacy stealth emails by login, url-encoded', () => {
    expect(githubEmailAvatarUrl('octo cat@users.noreply.github.com', 64)).toBe(
      'https://avatars.githubusercontent.com/octo%20cat?s=64&v=4'
    )
  })

  it('normalizes case and padding', () => {
    expect(githubEmailAvatarUrl(' 42+Octocat@USERS.NOREPLY.GITHUB.COM ')).not.toBeNull()
  })

  it('returns null for ordinary emails (those go through lookup/Gravatar)', () => {
    expect(githubEmailAvatarUrl('daniel.penalba@unity3d.com')).toBeNull()
  })
})

describe('withAvatarSize', () => {
  it('adds a size to an url without one', () => {
    expect(withAvatarSize('https://avatars.githubusercontent.com/u/42?v=4', 64)).toBe(
      'https://avatars.githubusercontent.com/u/42?v=4&s=64'
    )
  })

  it('overrides an existing size', () => {
    expect(withAvatarSize('https://example.com/a?s=460', 64)).toBe('https://example.com/a?s=64')
  })

  it('passes through unparseable urls untouched', () => {
    expect(withAvatarSize('not a url', 64)).toBe('not a url')
  })
})

describe('initials', () => {
  it('takes first + last initial of a full name', () => {
    expect(initials('Daniel Penalba')).toBe('DP')
  })

  it('takes the first two letters of a single name', () => {
    expect(initials('Madonna')).toBe('MA')
  })

  it('splits on dots, underscores and dashes', () => {
    expect(initials('jane.q-public')).toBe('JP')
  })

  it('falls back to the email when the name is blank', () => {
    expect(initials('', 'octocat@github.com')).toBe('OC')
  })

  it('returns ? when there is nothing to work with', () => {
    expect(initials('', '')).toBe('?')
  })
})

describe('avatarColor', () => {
  it('is deterministic for the same seed', () => {
    expect(avatarColor('alice')).toBe(avatarColor('alice'))
  })

  it('produces a valid hsl string with a hue in range', () => {
    const color = avatarColor('some-seed')
    const match = color.match(/^hsl\((\d+) 52% 48%\)$/)
    expect(match).not.toBeNull()
    const hue = Number(match?.[1])
    expect(hue).toBeGreaterThanOrEqual(0)
    expect(hue).toBeLessThan(360)
  })

  it('generally differs between distinct seeds', () => {
    expect(avatarColor('alice')).not.toBe(avatarColor('bob'))
  })
})
