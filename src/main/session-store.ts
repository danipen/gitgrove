// Persists the window session — which repos were open, one entry per window
// in window order — so relaunching GitGrove reopens exactly where the user
// left off. Saved whenever windows open, close or change repo; index.ts stops
// saving the moment quitting starts, so the quit's cascade of window closes
// can't whittle the session down to nothing before it's read again. A missing
// or corrupt file simply yields an empty session (one welcome window) —
// restoring is a convenience, never a reason to fail startup. Parsing/shape
// validation is the pure, unit-tested session.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { parseSession, type SessionWindows } from './session'

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
