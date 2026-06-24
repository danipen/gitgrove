// The write-side git runner: a small spawn wrapper shared by every mutating
// module (write.ts, rebase.ts, sync.ts). Supports stdin (for `git apply` /
// `git commit -F -`) and per-call environment overrides (for the
// non-interactive rebase editors). Commands never prompt: GIT_TERMINAL_PROMPT
// is off, so a missing credential fails fast with a readable error instead of
// hanging the app.

import { spawn } from 'node:child_process'
import { locateGit } from './bin'
import { PERF } from './perf'

export interface RunOptions {
  /** Text piped to git's stdin (e.g. a patch for `git apply -`). */
  input?: string
  /** Extra environment variables layered over the process env. */
  env?: Record<string, string>
  /** Exit codes (besides 0) treated as success; stdout is still returned. */
  tolerateExitCodes?: number[]
  /**
   * Receives phase + percent parsed from git's stderr progress stream while
   * the command runs. The caller must also pass `--progress` — git suppresses
   * progress when stderr is not a terminal.
   */
  onProgress?: ProgressHandler
}

export type ProgressHandler = (phase: string, percent: number) => void

/**
 * Extract progress reports from a chunk of git stderr. git updates a phase in
 * place with \r-separated lines like "Receiving objects:  42% (1234/2934)"
 * (server-side phases prefixed with "remote: "). Pure + exported for tests.
 */
export function parseProgressText(text: string, onProgress: ProgressHandler): void {
  for (const line of text.split(/[\r\n]/)) {
    const m = line.match(/^(?:remote: )?([A-Za-z- ]+):\s+(\d+)%/)
    if (m) onProgress(m[1], Number(m[2]))
  }
}

/**
 * Per-repo write queue. Two mutating git commands on the same repo must never
 * overlap — both would race for .git/index.lock and one dies with "Unable to
 * create index.lock: File exists". The renderer serializes user actions, but
 * watcher-driven work and menu commands can still interleave, so the real
 * guarantee lives here. There is exactly one queue per repo, shared by every
 * write module — which is why this map must stay in this module.
 */
const writeQueues = new Map<string, Promise<unknown>>()

export function enqueue<T>(repoPath: string, task: () => Promise<T>): Promise<T> {
  const tail = writeQueues.get(repoPath) ?? Promise.resolve()
  // Chain regardless of the predecessor's outcome; failures propagate to their
  // own caller only.
  const next = tail.then(task, task)
  writeQueues.set(
    repoPath,
    next.catch(() => {})
  )
  return next
}

/** Lock-contention retry schedule (ms). Covers a terminal/editor briefly holding the lock. */
const LOCK_RETRY_DELAYS = [150, 400, 900]

const isLockError = (message: string) =>
  /index\.lock|\.lock['"]?: File exists|Another git process/i.test(message)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Run a mutating git command: serialized per repo, with a short retry ladder
 * when an *external* process (editor git plugin, terminal) is holding the
 * index lock. Errors carry git's stderr (or stdout — some commands like
 * `merge` report conflicts there) so the renderer toast shows the real reason.
 */
export async function run(
  repoPath: string,
  args: string[],
  opts: RunOptions = {}
): Promise<string> {
  return enqueue(repoPath, () => runOnceWithRetry(repoPath, args, opts))
}

/**
 * Run one mutating git command with the lock-retry ladder but WITHOUT taking
 * the write queue — for callers composing an atomic multi-step write who
 * already hold the queue (via `enqueue`) and still want a single command to
 * ride out an external process briefly holding the index lock.
 */
export async function runOnceWithRetry(
  repoPath: string,
  args: string[],
  opts: RunOptions = {}
): Promise<string> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS.length; attempt++) {
    try {
      return await runOnce(repoPath, args, opts)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (!isLockError(lastError.message) || attempt === LOCK_RETRY_DELAYS.length) throw lastError
      await sleep(LOCK_RETRY_DELAYS[attempt])
    }
  }
  throw lastError ?? new Error('git command failed')
}

/**
 * Run a non-mutating git command from the write modules (stash list, worktree
 * list, …) WITHOUT the write queue. Reads never take the index lock, and
 * queueing them would make a snapshot refresh wait behind a slow network
 * operation.
 */
export function runRead(repoPath: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return runOnce(repoPath, args, opts)
}

/**
 * Run one git command immediately — no queue, no retry. Callers composing an
 * atomic multi-step write hold the queue themselves via `enqueue` and use
 * this inside it; network commands (fetch/push) use it because they never
 * take the index lock.
 */
export async function runOnce(
  repoPath: string,
  args: string[],
  opts: RunOptions = {}
): Promise<string> {
  const bin = await locateGit()
  const startedAt = PERF ? performance.now() : 0
  const logSlow = () => {
    if (!PERF) return
    const elapsed = performance.now() - startedAt
    if (elapsed > 300) {
      console.log(`[git] slow: git ${args.slice(0, 3).join(' ')} ${elapsed.toFixed(0)}ms`)
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: repoPath,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      stderr += text
      if (opts.onProgress) parseProgressText(text, opts.onProgress)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      logSlow()
      if (code === 0 || (code !== null && opts.tolerateExitCodes?.includes(code))) {
        resolve(stdout)
      } else {
        // With --progress the failure reason shares stderr with hundreds of
        // in-place percent updates; drop those so the toast shows the reason.
        const reason = opts.onProgress
          ? stderr
              .split(/[\r\n]/)
              .filter((l) => l.trim() && !/\d+%/.test(l))
              .join('\n')
          : stderr
        reject(new Error(reason.trim() || stdout.trim() || `git ${args[0]} failed (${code})`))
      }
    })
    if (opts.input !== undefined) {
      child.stdin.write(opts.input)
    }
    child.stdin.end()
  })
}
