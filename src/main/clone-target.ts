// Resolving and validating a clone destination. Kept Electron-free (only Node
// fs/os) so the logic is unit-testable against a temp directory — the clone
// dialog leans on it to block clones into occupied folders before git would.

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CloneTargetState } from '@shared/types'

/**
 * Expand a leading `~` (or `~/…`) to the home directory. We spawn git without
 * a shell, so a `~` the user typed into the path field would otherwise be
 * taken literally and create a folder actually named "~". Absolute paths and
 * anything without a leading `~` pass through untouched.
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Whether `targetPath` is a usable clone destination — git refuses to clone
 * into a directory that already has contents, and obviously can't clone over a
 * file. A missing path or an empty directory is fine.
 */
export async function cloneTargetState(targetPath: string): Promise<CloneTargetState> {
  const target = expandHome(targetPath)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(target)
  } catch {
    return 'ok' // doesn't exist yet — git will create it
  }
  if (!info.isDirectory()) return 'file'
  const entries = await readdir(target).catch(() => [])
  return entries.length === 0 ? 'ok' : 'not-empty'
}
