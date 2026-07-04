// The window session — which repos were open, one entry per window in window
// order — as pure data + validation, kept free of electron so it stays
// directly unit-testable (the file I/O lives in session-store.ts). Mirrors the
// window-state.ts / window-state-store.ts split.

/** One entry per window: its repo root, or null for a welcome-screen window. */
export type SessionWindows = (string | null)[]

// Safety valve against a corrupt file ballooning the restore; nobody works
// with anything near this many windows.
export const MAX_SESSION_WINDOWS = 20

/**
 * Validate raw JSON (untrusted: hand-edited, corrupt, or from a future
 * version) into a usable session. Anything that isn't a non-empty repo path
 * or a welcome-screen marker (null) is dropped.
 */
export function parseSession(raw: unknown): SessionWindows {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (entry): entry is string | null =>
        entry === null || (typeof entry === 'string' && entry.length > 0)
    )
    .slice(0, MAX_SESSION_WINDOWS)
}
