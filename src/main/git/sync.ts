// Network git operations: fetch, pull, push and clone. Fetch and push never
// touch the index, so they deliberately skip the write queue — a slow network
// operation must never make a one-file stage wait behind it. Pull rewrites
// the working tree, so it queues like any other write.
//
// These are the only operations that can need credentials, so they alone get
// `askpassEnv()`: prompts surface as the in-app credential dialog instead of
// failing on the disabled terminal prompt (see askpass.ts). Local writes
// never prompt and never get it. Auth failures are rethrown with a human
// message — git's raw stderr dump stays out of the toast.

import { spawn } from 'node:child_process'
import { askpassEnv } from './askpass'
import { friendlyAuthError } from './askpass-prompt'
import { locateGit, locateGitLfs } from './bin'
import { type ProgressHandler, parseProgressText, run, runOnce, runRead } from './exec'
import { getLfsHealth } from './lfs'
import { openLfsProgressChannel } from './lfs-progress'

/**
 * Run a network git operation with an LFS progress side channel attached
 * (see lfs-progress.ts): LFS moves its content after git's own transfer and
 * reports nothing on stderr, so without this a large LFS pull looks frozen.
 * No-op plumbing when the caller doesn't track progress.
 */
async function withLfsProgress<T>(
  onProgress: ProgressHandler | undefined,
  op: (lfsEnv: Record<string, string>) => Promise<T>
): Promise<T> {
  if (!onProgress) return op({})
  const channel = openLfsProgressChannel(onProgress)
  try {
    return await op(channel.env)
  } finally {
    await channel.dispose()
  }
}

export async function fetch(
  repoPath: string,
  remote?: string,
  onProgress?: ProgressHandler,
  opts: { quiet?: boolean } = {}
): Promise<void> {
  const args = ['fetch', '--prune', '--progress']
  if (remote) args.push(remote)
  // Quiet fetches (the renderer's background timer) never prompt: without
  // GIT_ASKPASS the disabled terminal prompt makes git fail fast and silent —
  // a timer must never pop a credential dialog under the user.
  const env = opts.quiet ? {} : await askpassEnv()
  await withLfsProgress(onProgress, (lfsEnv) =>
    runOnce(repoPath, args, { onProgress, env: { ...env, ...lfsEnv } })
  ).catch(rethrowFriendly(env))
}

export async function pull(
  repoPath: string,
  opts: { rebase?: boolean } = {},
  onProgress?: ProgressHandler
): Promise<void> {
  const args = ['-c', 'core.editor=true', 'pull', '--progress']
  if (opts.rebase) args.push('--rebase')
  else args.push(...(await divergentPullArgs(repoPath)))
  const env = await askpassEnv()
  await withLfsProgress(onProgress, (lfsEnv) =>
    run(repoPath, args, { onProgress, env: { ...env, ...lfsEnv } })
  ).catch(rethrowFriendly(env))
}

/**
 * Extra args that tell a plain (non-rebase) pull how to reconcile a *divergent*
 * branch. Since git 2.27 a bare `git pull` that can't fast-forward aborts with
 * "fatal: Need to specify how to reconcile divergent branches" unless the
 * strategy is pinned — via pull.rebase, pull.ff, or a flag. Our toolbar surfaces
 * Pull the instant the branch is behind, so an ahead+behind (diverged) branch
 * hits that fatal and strands the user: Pull keeps failing and Push is blocked
 * for being behind, with no obvious way out.
 *
 * So when the user hasn't stated a preference (pull.ff unset) we default to
 * `--ff`: fast-forward when possible, merge when diverged — the intuitive
 * behaviour, and enough to satisfy git's reconciliation check. If pull.ff is
 * set we pass nothing and let their config win; pull.rebase, if set, git honours
 * over `--ff` regardless (rebase path taken).
 */
async function divergentPullArgs(repoPath: string): Promise<string[]> {
  const pullFf = await runRead(repoPath, ['config', '--get', 'pull.ff'], {
    tolerateExitCodes: [1]
  }).catch(() => '')
  return pullFf.trim() ? [] : ['--ff']
}

export async function push(
  repoPath: string,
  opts: { setUpstream?: { remote: string; branch: string }; forceWithLease?: boolean } = {},
  onProgress?: ProgressHandler
): Promise<void> {
  const args = ['push', '--progress']
  if (opts.forceWithLease) args.push('--force-with-lease')
  if (opts.setUpstream) args.push('-u', opts.setUpstream.remote, opts.setUpstream.branch)
  const env = await askpassEnv()
  await withLfsProgress(onProgress, (lfsEnv) =>
    runOnce(repoPath, args, { onProgress, env: { ...env, ...lfsEnv } })
  ).catch(rethrowFriendly(env))
}

/**
 * Re-throw with a human auth message when the failure is credential-related.
 * `env` is the askpass environment that was applied — empty when setup failed
 * or the op was quiet, which tells friendlyAuthError not to read git's
 * "terminal prompts disabled" as a user cancellation.
 */
function rethrowFriendly(env: Record<string, string>): (e: unknown) => never {
  const askpassActive = Object.keys(env).length > 0
  return (e) => {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(friendlyAuthError(message, askpassActive) ?? message)
  }
}

/**
 * Clone with progress into the exact directory `dest` (the dialog composes it
 * as `<base>/<repo-name>`, but the user can edit the whole path, so we clone
 * where told rather than re-deriving a name). git reports progress on stderr
 * as lines like "Receiving objects:  42% (1234/2934)"; we forward phase +
 * percent to the caller. `--recurse-submodules` brings submodules down in the
 * same pass; LFS content is materialized afterwards (see materializeLfs).
 * Resolves with the path of the new repo.
 */
export async function clone(
  url: string,
  dest: string,
  onProgress: ProgressHandler
): Promise<string> {
  const bin = await locateGit()
  const credentialEnv = await askpassEnv()
  await withLfsProgress(onProgress, async (lfsEnv) => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['clone', '--progress', '--recurse-submodules', url, dest], {
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...credentialEnv, ...lfsEnv }
      })
      let stderrTail = ''
      child.stderr.on('data', (d: Buffer) => {
        const text = d.toString('utf8')
        stderrTail = (stderrTail + text).slice(-4000)
        parseProgressText(text, onProgress)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else {
          // The tail of stderr holds the human-readable failure (auth, 404, …).
          const lines = stderrTail.split('\n').filter((l) => l.trim() && !/\d+%/.test(l))
          const reason = lines.slice(-3).join('\n') || 'git clone failed'
          const askpassActive = Object.keys(credentialEnv).length > 0
          reject(new Error(friendlyAuthError(stderrTail, askpassActive) ?? reason))
        }
      })
    })
    await materializeLfs(dest, lfsEnv, onProgress)
  })
  return dest
}

/**
 * Pull the real LFS content of a freshly cloned repo. git clone only smudges
 * LFS files into their real bytes when the smudge/clean filters already exist
 * machine-wide; on a machine where `git lfs install` was never run they land
 * as small pointer text files and the repo looks broken. So for an LFS repo
 * with the binary available we wire up this repo's filters and pull — turning
 * a just-cloned LFS repo usable immediately instead of after the user trips
 * over the repo-open LFS banner. Entirely best-effort: any failure here leaves
 * the clone itself intact (that banner is still the safety net), so we never
 * reject the clone over an LFS hiccup.
 */
async function materializeLfs(
  dest: string,
  lfsEnv: Record<string, string>,
  onProgress: ProgressHandler
): Promise<void> {
  const health = await getLfsHealth(dest).catch(() => null)
  if (!health?.usesLfs || !health.binaryAvailable) return
  await locateGitLfs()
  await run(dest, ['lfs', 'install', '--local']).catch(() => {})
  onProgress('Fetching LFS objects', 0)
  await run(dest, ['lfs', 'pull'], { onProgress, env: lfsEnv }).catch(() => {})
}
