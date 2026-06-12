import { useEffect, useState } from 'react'

import { avatarColor, gravatarUrl, initials } from '@/lib/avatar'

interface Props {
  name: string
  email: string
  size?: number
}

// Module-level caches that outlive any single row. The history list is
// virtualized, so a row scrolled out of view and back in remounts its Avatar —
// without these it would flash initials → blank <img> → image every time.
// Keyed by the resolved Gravatar URL: a known-good image shows immediately, a
// known-404 one is skipped entirely (no repeat request, no flicker).
const resolvedUrls = new Map<string, string | null>()
const loadedUrls = new Set<string>()
const failedUrls = new Set<string>()

/** Round author avatar: a colored initials disc that a Gravatar image covers
 *  once (and if) it loads. The initials always render underneath, so swapping
 *  in the image — or falling back when there is none — never blinks. */
export function Avatar({ name, email, size = 28 }: Props) {
  const cacheKey = `${email.trim().toLowerCase()}|${size}`
  const [src, setSrc] = useState<string | null>(() => resolvedUrls.get(cacheKey) ?? null)

  // Resolve the Gravatar URL (an async email hash) once per email+size and
  // remember it, so later mounts read it synchronously from the cache instead
  // of dropping back to initials for a frame.
  useEffect(() => {
    if (resolvedUrls.has(cacheKey)) {
      setSrc(resolvedUrls.get(cacheKey) ?? null)
      return
    }
    if (!email.trim()) {
      resolvedUrls.set(cacheKey, null)
      setSrc(null)
      return
    }
    let alive = true
    gravatarUrl(email, size * 2).then((url) => {
      resolvedUrls.set(cacheKey, url)
      if (alive) setSrc(url)
    })
    return () => {
      alive = false
    }
  }, [cacheKey, email, size])

  // Per-URL load outcome, seeded from the caches: a revisited image starts
  // visible (no re-fade), a known-bad one renders only the initials.
  const [loaded, setLoaded] = useState(() => (src ? loadedUrls.has(src) : false))
  const [failed, setFailed] = useState(() => (src ? failedUrls.has(src) : false))
  useEffect(() => {
    setLoaded(src ? loadedUrls.has(src) : false)
    setFailed(src ? failedUrls.has(src) : false)
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
      {src && !failed && (
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
            setFailed(true)
          }}
        />
      )}
    </span>
  )
}
