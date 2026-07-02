// Ordered avatar-source resolution, shared by the DOM <Avatar> (history lists,
// commit summaries) and the Graph tab's canvas nodes. Extracted here so both
// walk the exact same fallback chain and share one cache.
//
// Ordered avatar sources for an identity, best first:
//   1. deterministic GitHub url — stealth emails encode their owner;
//   2. a known LLM vendor's product icon (Claude/Copilot/Cursor…), matched
//      from the name/email — works with no account and on non-GitHub repos;
//   3. the connected account's email lookup (exact hits, detectable misses);
//   4. Gravatar, whose `d=404` makes its misses detectable too.

import { githubEmailAvatarUrl, gravatarUrl, withAvatarSize } from '@/lib/avatar'
import { llmVendors } from '@/lib/llm-vendors'

// Candidate lists per identity+size, resolved once and kept for the session so
// remounts (virtualized rows, canvas redraws) read them synchronously.
const resolvedCandidates = new Map<string, string[]>()

// Authed host lookups (main process asks the connected account's API), one
// in-flight promise per unique email. Definite answers — found, or "no user
// with that email" — stay cached for the session; transient failures evict
// themselves so a later mount retries. Connecting/removing an account clears
// everything, since every answer may change.
const hostLookups = new Map<string, Promise<string | null>>()
let accountsSubscribed = false

function lookupHostedAvatarUrl(email: string): Promise<string | null> {
  if (!accountsSubscribed) {
    accountsSubscribed = true
    window.gitgrove.onAccountsChanged(() => {
      hostLookups.clear()
      resolvedCandidates.clear()
    })
  }
  const key = email.trim().toLowerCase()
  let lookup = hostLookups.get(key)
  if (!lookup) {
    lookup = window.gitgrove
      .lookupAvatarUrl(email)
      .then((result) => {
        if (!result.ok) hostLookups.delete(key)
        return result.url
      })
      .catch(() => {
        hostLookups.delete(key)
        return null
      })
    hostLookups.set(key, lookup)
  }
  return lookup
}

async function resolveCandidates(name: string, email: string, size: number): Promise<string[]> {
  const candidates: string[] = []
  const stealth = githubEmailAvatarUrl(email, size)
  const vendor = stealth ? null : llmVendors.avatarUrlFor(name, email, size)
  if (stealth) candidates.push(stealth)
  if (vendor) candidates.push(vendor)
  if (email.trim()) {
    if (!stealth && !vendor) {
      // Deterministic identities never have a searchable profile email —
      // only unrecognized ones are worth an API lookup.
      const hosted = await lookupHostedAvatarUrl(email)
      if (hosted) candidates.push(withAvatarSize(hosted, size))
    }
    candidates.push(await gravatarUrl(email, size))
  }
  return candidates
}

/** The name participates in resolution (LLM vendor detection), so it's part
 *  of the identity key alongside the email. */
const cacheKey = (name: string, email: string, size: number) =>
  `${name.trim()}|${email.trim().toLowerCase()}|${size}`

/** Synchronous cache read — the already-resolved list, or null. */
export function peekAvatarCandidates(name: string, email: string, size: number): string[] | null {
  return resolvedCandidates.get(cacheKey(name, email, size)) ?? null
}

/** Resolve (and remember) the ordered candidate urls for an identity+size. */
export async function resolveAvatarCandidates(
  name: string,
  email: string,
  size: number
): Promise<string[]> {
  const key = cacheKey(name, email, size)
  const cached = resolvedCandidates.get(key)
  if (cached) return cached
  const urls = await resolveCandidates(name, email, size)
  resolvedCandidates.set(key, urls)
  return urls
}
