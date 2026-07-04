// Tiny JSON-file store for "recently opened" repositories, kept in the app's
// userData directory so it survives restarts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoInfo } from '@shared/types'
import { app } from 'electron'

// Generous cap: the switcher shows the newest few under "Recent" and the rest
// under "All", so retaining a long tail is what makes the filter useful.
const MAX_RECENT = 100

/** What we persist per recent repo (the `missing` flag is computed on read). */
interface StoredRepo extends RepoInfo {
  lastOpened: number
  remoteUrl?: string | null
}

function storePath(): string {
  return join(app.getPath('userData'), 'recent-repos.json')
}

function read(): StoredRepo[] {
  try {
    const file = storePath()
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as StoredRepo[]) : []
  } catch {
    return []
  }
}

// Fired after every successful write so OS surfaces built from the recents
// (the macOS dock menu, the Windows Jump List — see app-shortcuts.ts) can
// rebuild. One listener is all the app needs; a change bus would be ceremony.
let recentsChangedListener: (() => void) | null = null
export function setRecentsChangedListener(listener: () => void): void {
  recentsChangedListener = listener
}

function write(repos: StoredRepo[]): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(storePath(), JSON.stringify(repos, null, 2), 'utf8')
    recentsChangedListener?.()
  } catch {
    // non-fatal: recents are a convenience only
  }
}

/**
 * All recent repos, newest first. Repos whose folder is gone are kept (flagged
 * `missing`) rather than filtered out, so the user can recover them — selecting
 * one opens the recovery screen (Locate / Clone Again / Remove).
 */
export function getRecentRepos() {
  return read()
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .map((r) => ({ ...r, missing: !existsSync(r.path) }))
}

/** The stored entry for `path` (name + last-known remote), or null. */
export function getRecentRepo(path: string): StoredRepo | null {
  return read().find((r) => r.path === path) ?? null
}

export function rememberRepo(repo: RepoInfo & { remoteUrl?: string | null }) {
  const existing = read().filter((r) => r.path !== repo.path)
  const updated: StoredRepo[] = [{ ...repo, lastOpened: Date.now() }, ...existing].slice(
    0,
    MAX_RECENT
  )
  write(updated)
  return getRecentRepos()
}

export function removeRecentRepo(path: string) {
  write(read().filter((r) => r.path !== path))
  return getRecentRepos()
}
