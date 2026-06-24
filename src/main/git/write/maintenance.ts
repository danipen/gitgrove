// Large-repo optimizations: turn on the levers git itself recommends (and
// `scalar` applies) for huge working trees.

import { run, runRead } from '../exec'

/**
 * Enable git's built-in machinery for huge working trees — the same levers
 * git itself recommends (and `scalar` applies) for monorepos:
 *
 *  - `core.fsmonitor` — a daemon tells git *which* paths changed, so `status`
 *    stops lstat-crawling the whole tree (seconds → tens of ms);
 *  - `core.untrackedCache` — cached untracked-file enumeration;
 *  - index version 4 — prefix-compressed index, much faster to read/write
 *    (this is what makes a one-file `git add`/`reset` fast on 90k entries).
 *
 * Finishes with one cache-warming `git status` that is *allowed* to take
 * optional locks, so the fsmonitor token and untracked cache persist
 * immediately instead of on the next write.
 */
export async function optimizeRepo(repoPath: string): Promise<void> {
  await run(repoPath, ['config', 'core.untrackedCache', 'true'])
  // `core.fsmonitor true` means the *built-in* daemon only on git ≥ 2.37
  // (macOS/Windows); on older gits it would be misread as a hook path and
  // make every status warn. The other levers still help by themselves.
  const version = (await runRead(repoPath, ['--version']).catch(() => '')).match(/(\d+)\.(\d+)/)
  const fsmonitorSupported =
    version !== null &&
    (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 37)) &&
    process.platform !== 'linux'
  if (fsmonitorSupported) {
    await run(repoPath, ['config', 'core.fsmonitor', 'true']).catch(() => {})
  }
  await run(repoPath, ['update-index', '--index-version', '4'])
  // Cache-warming status that is allowed to take optional locks, so the
  // untracked cache (and fsmonitor token) persist right away.
  await run(repoPath, ['status', '--porcelain=2', '-z', '--untracked-files=all'], {
    env: { GIT_OPTIONAL_LOCKS: '1' }
  })
}
