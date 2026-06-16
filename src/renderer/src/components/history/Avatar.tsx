import { useEffect, useState } from 'react'

import {
  avatarColor,
  githubEmailAvatarUrl,
  gravatarUrl,
  initials,
  withAvatarSize
} from '@/lib/avatar'
import { llmVendors } from '@/lib/llm-vendors'

interface Props {
  name: string
  email: string
  size?: number
}

// Module-level caches that outlive any single row. The history list is
// virtualized, so a row scrolled out of view and back in remounts its Avatar —
// without these it would flash initials → blank <img> → image every time.
// `resolvedCandidates` holds the ordered fallback urls per identity+size
// (GitHub/vendor → Gravatar); `loadedUrls`/`failedUrls` remember each url's
// outcome so a known-good image shows immediately and a known-404 one is
// skipped entirely (no repeat request, no flicker).
const resolvedCandidates = new Map<string, string[]>()
const loadedUrls = new Set<string>()
const failedUrls = new Set<string>()

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

/**
 * Ordered avatar sources for an identity, best first:
 *   1. deterministic GitHub url — stealth emails encode their owner;
 *   2. a known LLM vendor's product icon (Claude/Copilot/Cursor…), matched
 *      from the name/email — works with no account and on non-GitHub repos;
 *   3. the connected account's email lookup (exact hits, detectable misses);
 *   4. Gravatar, whose `d=404` makes its misses detectable too.
 * The <img> onError walks this list; when every candidate fails, the
 * initials disc underneath simply stays.
 */
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

/** Round author avatar: a colored initials disc that the best available
 *  remote image covers once (and if) it loads. The initials always render
 *  underneath, so swapping in the image — or falling back through the
 *  candidate chain when one 404s — never blinks. */
export function Avatar({ name, email, size = 28 }: Props) {
  // The name participates in resolution (LLM vendor detection), so it's part
  // of the identity key alongside the email.
  const cacheKey = `${name.trim()}|${email.trim().toLowerCase()}|${size}`
  const [candidates, setCandidates] = useState<string[]>(
    () => resolvedCandidates.get(cacheKey) ?? []
  )
  // Bumped when a url fails so the `src` pick below re-runs; the url itself
  // lands in `failedUrls`, shared by every Avatar showing this person.
  const [, setFailCount] = useState(0)

  // Resolve the candidate list once per identity+size and remember it, so
  // later mounts read it synchronously instead of dropping to initials for a
  // frame.
  useEffect(() => {
    const cached = resolvedCandidates.get(cacheKey)
    if (cached) {
      setCandidates(cached)
      return
    }
    let alive = true
    // Images are requested at 2x for crisp rendering on retina displays.
    resolveCandidates(name, email, size * 2).then((urls) => {
      resolvedCandidates.set(cacheKey, urls)
      if (alive) setCandidates(urls)
    })
    return () => {
      alive = false
    }
  }, [cacheKey, name, email, size])

  // First candidate not known to 404; none left → initials only.
  const src = candidates.find((url) => !failedUrls.has(url)) ?? null

  // Per-URL load outcome, seeded from the cache: a revisited image starts
  // visible (no re-fade).
  const [loaded, setLoaded] = useState(() => (src ? loadedUrls.has(src) : false))
  useEffect(() => {
    setLoaded(src ? loadedUrls.has(src) : false)
  }, [src])

  // The app-wide TooltipLayer tooltip (instant, styled) instead of the slow
  // native `title`: name on the first line, email dimmed underneath.
  const tipTitle = name.trim() || email.trim()
  const tipEmail = email.trim()

  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: avatarColor(email || name)
      }}
      data-tip={tipTitle}
      data-tip-sub={tipEmail && tipEmail !== tipTitle ? tipEmail : undefined}
    >
      {/* Flex centering aligns the line box, whose ascent/descent are asymmetric, so
          uppercase initials land ~1px below the optical center at small sizes. Trimming
          the text box to the cap/baseline edges centers the actual letters at any size. */}
      <span style={{ textBoxTrim: 'trim-both', textBoxEdge: 'cap alphabetic' }}>
        {initials(name, email)}
      </span>
      {src && (
        <img
          className="avatar__img"
          src={src}
          alt=""
          width={size}
          height={size}
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => {
            loadedUrls.add(src)
            setLoaded(true)
          }}
          onError={() => {
            failedUrls.add(src)
            setFailCount((count) => count + 1)
          }}
        />
      )}
    </span>
  )
}
