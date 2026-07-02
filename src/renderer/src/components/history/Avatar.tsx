import { useEffect, useState } from 'react'

import { avatarColor, initials } from '@/lib/avatar'
import { peekAvatarCandidates, resolveAvatarCandidates } from '@/lib/avatar-sources'

interface Props {
  name: string
  email: string
  size?: number
}

// Per-URL load outcomes that outlive any single row. The history list is
// virtualized, so a row scrolled out of view and back in remounts its Avatar —
// these remember each url's outcome so a known-good image shows immediately
// and a known-404 one is skipped entirely (no repeat request, no flicker).
// The candidate lists themselves are cached in lib/avatar-sources, shared
// with the Graph canvas.
const loadedUrls = new Set<string>()
const failedUrls = new Set<string>()

/** Round author avatar: a colored initials disc that the best available
 *  remote image covers once (and if) it loads. The initials always render
 *  underneath, so swapping in the image — or falling back through the
 *  candidate chain when one 404s — never blinks. */
export function Avatar({ name, email, size = 28 }: Props) {
  // Images are requested at 2x for crisp rendering on retina displays.
  const [candidates, setCandidates] = useState<string[]>(
    () => peekAvatarCandidates(name, email, size * 2) ?? []
  )
  // Bumped when a url fails so the `src` pick below re-runs; the url itself
  // lands in `failedUrls`, shared by every Avatar showing this person.
  const [, setFailCount] = useState(0)

  // Resolve the candidate list once per identity+size (cached in
  // avatar-sources), so later mounts read it synchronously instead of
  // dropping to initials for a frame.
  useEffect(() => {
    let alive = true
    resolveAvatarCandidates(name, email, size * 2).then((urls) => {
      if (alive) setCandidates(urls)
    })
    return () => {
      alive = false
    }
  }, [name, email, size])

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
