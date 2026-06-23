// Where the clone dialog proposes to put new repositories. We remember the
// last parent folder the user cloned into (so the second clone lands beside
// the first) and fall back to `<home>/Projects` the first time — a short,
// top-level folder that every OS file manager (Finder, Nautilus, Explorer)
// surfaces, rather than burying clones somewhere the user can't easily reach.
//
// Kept tiny and Electron-light (only `app.getPath` for userData) so it mirrors
// store.ts and stays trivially understandable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

interface ClonePrefs {
  /** Last parent folder a clone landed in; absent until the first clone. */
  baseDir?: string
}

function storePath(): string {
  return join(app.getPath('userData'), 'clone-prefs.json')
}

function read(): ClonePrefs {
  try {
    const file = storePath()
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed as ClonePrefs
    }
  } catch {
    // Unreadable prefs are non-fatal — fall through to the default folder.
  }
  return {}
}

/** The parent folder to prefill in the clone dialog. */
export function getCloneBaseDir(): string {
  const remembered = read().baseDir
  return remembered && existsSync(remembered) ? remembered : join(homedir(), 'Projects')
}

/** Remember the parent folder of the most recent clone for next time. */
export function rememberCloneBaseDir(baseDir: string): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(storePath(), JSON.stringify({ baseDir }, null, 2), 'utf8')
  } catch {
    // Non-fatal: the proposed folder just won't persist across restarts.
  }
}
