// Helpers for rendering commit author avatars. Gravatar supports SHA-256
// hashes of the lowercased, trimmed email, which we can compute with the
// browser's SubtleCrypto (MD5 isn't available there). `d=404` makes Gravatar
// 404 when the author has no avatar so the UI can fall back to initials.

const hashCache = new Map<string, Promise<string>>()

function sha256Hex(input: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)).then((buf) =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

// GitHub's public email→avatar image endpoint (/u/e?email=…) can't be part of
// a fallback chain: it answers identicons for unknown emails, so a miss is
// undetectable. Stealth emails are the exception — the email itself encodes
// which GitHub identity owns it, so the URL is deterministic and a 404 (gone
// account) falls through to Gravatar/initials like any failed image.
const STEALTH_EMAIL = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/

/**
 * Deterministic GitHub avatar URL for emails that encode their owner —
 * `ID+login@users.noreply.github.com` stealth emails (incl. `…[bot]` apps
 * like Claude's GitHub App and dependabot) and legacy `login@users.noreply…`.
 * Null for everything else.
 */
export function githubEmailAvatarUrl(email: string, size = 80): string | null {
  const stealth = STEALTH_EMAIL.exec(email.trim().toLowerCase())
  if (!stealth) return null
  const [, id, login] = stealth
  return id
    ? `https://avatars.githubusercontent.com/u/${id}?s=${size}&v=4`
    : `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=${size}&v=4`
}

/** `url` with its size query forced to `size` (API avatar urls carry none). */
export function withAvatarSize(url: string, size: number): string {
  try {
    const sized = new URL(url)
    sized.searchParams.set('s', String(size))
    return sized.toString()
  } catch {
    return url
  }
}

export function gravatarUrl(email: string, size = 80): Promise<string> {
  const key = email.trim().toLowerCase()
  let hash = hashCache.get(key)
  if (!hash) {
    hash = sha256Hex(key)
    hashCache.set(key, hash)
  }
  return hash.then((h) => `https://gravatar.com/avatar/${h}?s=${size}&d=404`)
}

/** Up to two initials from an author name, falling back to the email. */
export function initials(name: string, email = ''): string {
  const source = name.trim() || email.trim()
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Deterministic, pleasant background color for an initials avatar. */
export function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 52% 48%)`
}
