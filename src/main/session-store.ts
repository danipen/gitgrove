// Persists the window session — which repos were open, one entry per window
// in window order — so relaunching GitGrove reopens exactly where the user
// left off. Saved whenever windows open, close or change repo; index.ts stops
// saving the moment quitting starts, so the quit's cascade of window closes
// can't whittle the session down to nothing before it's read again. A missing
// or corrupt file simply yields an empty session (one welcome window) —
// restoring is a convenience, never a reason to fail startup.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** One entry per window: its repo root, or null for a welcome-screen window. */
export type SessionWindows = (string | null)[]

// Safety valve against a corrupt file ballooning the restore; nobody works
// with anything near this many windows.
const MAX_SESSION_WINDOWS = 20

/**
 * Validate raw JSON (untrusted: hand-edited, corrupt, or from a future
 * version) into a usable session. Anything that isn't a non-empty repo path
 * or a welcome-screen marker (null) is dropped. Pure, for direct unit tests.
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

function sessionFile(): string {
  return join(app.getPath('userData'), 'session.json')
}

/** The last run's windows, oldest window first. Empty when there's nothing usable. */
export function loadSession(): SessionWindows {
  try {
    if (!existsSync(sessionFile())) return []
    return parseSession(JSON.parse(readFileSync(sessionFile(), 'utf8')))
  } catch {
    return []
  }
}

export function saveSession(session: SessionWindows): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(sessionFile(), JSON.stringify(session, null, 2), 'utf8')
  } catch {
    // non-fatal: worst case the next launch opens a welcome window
  }
}
