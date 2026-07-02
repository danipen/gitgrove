// Author avatars for the Graph canvas: HTMLImageElement per identity, loaded
// through the same ordered fallback chain as the DOM <Avatar> (see
// lib/avatar-sources) and kept for the session. The canvas draws the colored
// initials disc itself until (and unless) an image lands, so nodes never blink.

import { resolveAvatarCandidates } from '@/lib/avatar-sources'

/** Requested at 2x the drawn 24px node face for crisp retina rendering. */
const IMAGE_SIZE = 48

interface Entry {
  image: HTMLImageElement | null
  started: boolean
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

/** Subscribe to "an avatar became drawable" — invalidate the canvas on it. */
export function subscribeAvatars(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** Try each candidate url in order; keep the first image that loads. */
async function load(entry: Entry, name: string, email: string): Promise<void> {
  const candidates = await resolveAvatarCandidates(name, email, IMAGE_SIZE)
  for (const url of candidates) {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
    })
    if (image) {
      entry.image = image
      notify()
      return
    }
  }
}

/**
 * The identity's avatar image if it has loaded; null (and a background load
 * kicked off) otherwise. Synchronous by design — called mid-draw.
 */
export function avatarImageFor(name: string, email: string): HTMLImageElement | null {
  const key = `${name.trim()}|${email.trim().toLowerCase()}`
  let entry = entries.get(key)
  if (!entry) {
    entry = { image: null, started: false }
    entries.set(key, entry)
  }
  if (!entry.started) {
    entry.started = true
    load(entry, name, email).catch(() => {})
  }
  return entry.image
}
