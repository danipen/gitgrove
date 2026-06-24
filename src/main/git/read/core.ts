// The read-side core: one thin execFile wrapper with exact control over
// arguments, formatting and exit codes (rather than a wrapper library), plus
// the low-level read primitives the domain modules share — blob/file readers,
// the empty-tree constant, the contents cap, and git error sniffing.
//
// All output that contains file paths or user text is NUL-delimited (`-z` /
// `%x00`), because NUL is the only byte git guarantees can never appear inside
// refnames, paths, or commit messages.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { locateGit } from '../bin'

const execFileAsync = promisify(execFile)

/** Git's well-known empty tree object, used to diff root commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Cap on the combined old+new file contents shipped to enable expandable
 * context. Above this we omit contents and the viewer falls back to the
 * (non-expandable) patch render.
 */
export const MAX_CONTENTS_BYTES = 3 * 1024 * 1024

/**
 * Raised when git refuses a repo because it can't verify directory ownership
 * ("detected dubious ownership") — a false positive on Parallels shared folders,
 * network drives, and other filesystems that don't record ownership (e.g.
 * //Mac/Home/...). Carries the repo path (for display) and the exact
 * `safe.directory` value git recommends, so the app can offer to trust it after
 * the user confirms (see {@link addSafeDirectory}).
 */
export class DubiousOwnershipError extends Error {
  readonly path: string
  readonly safeValue: string
  constructor(stderr: string) {
    super('Git repository has dubious ownership.')
    this.name = 'DubiousOwnershipError'
    // "...dubious ownership in repository at '//Mac/Home/.../oniguruma'"
    this.path = stderr.match(/repository at '([^']+)'/)?.[1] ?? ''
    // git prints the exact remedy: `... safe.directory '<value>'`
    this.safeValue = stderr.match(/safe\.directory '([^']+)'/)?.[1] ?? this.path
  }
}

// Reads must never take the index lock: `git status` refreshes the stat cache
// by default, which creates .git/index.lock and collides with a concurrent
// stage/commit ("index.lock: File exists"). GIT_OPTIONAL_LOCKS=0 makes status
// & friends skip that optional write. Set on our own process env so every
// spawned git inherits it. Mutating writes are unaffected — their index lock
// is mandatory, not optional.
process.env.GIT_OPTIONAL_LOCKS = '0'

/**
 * Raised when a command's stdout exceeds `runGit`'s maxBuffer. The diff layer
 * turns this into a "too large to display" notice instead of a raw error.
 */
export class GitOutputTooLargeError extends Error {
  constructor() {
    super('git output exceeded the maximum buffer size')
    this.name = 'GitOutputTooLargeError'
  }
}

/**
 * Run a raw git command, returning stdout regardless of exit code when the code
 * is in `tolerateExitCodes` (git diff family uses code 1 to mean "differences
 * found", which is not an error for us). Exported for the snapshot module.
 */
export async function runGit(
  repoPath: string,
  args: string[],
  tolerateExitCodes: number[] = []
): Promise<string> {
  const bin = await locateGit()
  try {
    const { stdout } = await execFileAsync(bin, args, {
      cwd: repoPath,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true
    })
    return stdout
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    if (typeof e.code === 'number' && tolerateExitCodes.includes(e.code)) {
      return e.stdout ?? ''
    }
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new GitOutputTooLargeError()
    const stderr = e.stderr ?? ''
    // Surface the ownership case as a distinct, recoverable error so the app can
    // offer to trust the folder rather than reporting "not a git repository".
    if (/dubious ownership/i.test(stderr)) throw new DubiousOwnershipError(stderr)
    throw new Error(stderr.trim() || e.message || 'git command failed')
  }
}

/**
 * Persist a global `safe.directory` exception so git trusts this repo from now
 * on (in GitGrove, the terminal, and other git tools alike). Only call this
 * after the user has explicitly chosen to trust the folder.
 */
export async function addSafeDirectory(value: string): Promise<void> {
  const bin = await locateGit()
  await execFileAsync(bin, ['config', '--global', '--add', 'safe.directory', value], {
    windowsHide: true
  })
}

/** Resolve the top-level working directory for any path inside a repo. */
export async function resolveRepoRoot(somePath: string): Promise<string | null> {
  try {
    const out = await runGit(somePath, ['rev-parse', '--show-toplevel'])
    const root = out.trim()
    return root || null
  } catch (e) {
    // A trust problem is recoverable (the caller can offer to trust the folder),
    // so let it through; any other failure just means "not a repo here".
    if (e instanceof DubiousOwnershipError) throw e
    return null
  }
}

/** True when an error means `<hash>^` didn't resolve (root commit, no parent). */
export const isNoParentError = (e: unknown) =>
  e instanceof Error && /unknown revision|bad revision/i.test(e.message)

/** Read a blob's contents at a ref (`git show <ref>:<path>`); null if absent. */
export async function showFile(
  repoPath: string,
  ref: string,
  path: string
): Promise<string | null> {
  try {
    return await runGit(repoPath, ['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

/** Read a working-tree file from disk; null if unreadable. */
export async function readWorkingFile(repoPath: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, path), 'utf8')
  } catch {
    return null
  }
}
