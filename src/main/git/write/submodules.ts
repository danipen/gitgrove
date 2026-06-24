// Listing and updating submodules.

import type { SubmoduleInfo } from '@shared/types'
import { run, runRead } from '../exec'

/** Parse `git submodule status` output. Exported for tests. */
export function parseSubmodules(out: string): SubmoduleInfo[] {
  const mods: SubmoduleInfo[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    // "<flag><sha> <path> (<describe>)" — flag is ' ', '+', '-', or 'U'.
    const m = line.match(/^([ +\-U])([0-9a-f]+) (\S+)/)
    if (!m) continue
    const [, flag, sha, path] = m
    mods.push({
      path,
      shaShort: sha.slice(0, 7),
      state:
        flag === '-'
          ? 'uninitialized'
          : flag === '+'
            ? 'modified'
            : flag === 'U'
              ? 'conflict'
              : 'clean'
    })
  }
  return mods
}

export async function listSubmodules(repoPath: string): Promise<SubmoduleInfo[]> {
  const out = await runRead(repoPath, ['submodule', 'status']).catch(() => '')
  return parseSubmodules(out)
}

export async function updateSubmodules(repoPath: string): Promise<void> {
  await run(repoPath, ['submodule', 'update', '--init', '--recursive'])
}
