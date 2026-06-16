// Read-side git access for the main process: one thin execFile wrapper with
// exact control over arguments, formatting and exit codes, rather than a
// wrapper library. All output that contains file paths or user text is
// NUL-delimited (`-z` / `%x00`), because NUL is the only byte git guarantees
// can never appear inside refnames, paths, or commit messages.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  BlameLine,
  BranchInfo,
  ChangedFile,
  Commit,
  ConflictSides,
  DiffArea,
  DiffPayload,
  FileStatus,
  LogOptions,
  MergePreview,
  RepoSummary
} from '@shared/types'
import { locateGit } from './bin'
import { imageMimeType, loadCommitImageSides, loadWorkingImageSides } from './image'
import { describeLfsPatch } from './lfs-pointer'
import { describeSubmodulePatch } from './submodule-patch'

const execFileAsync = promisify(execFile)

/** Git's well-known empty tree object, used to diff root commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Refuse to ship patches larger than this to the renderer (bytes). */
const MAX_PATCH_BYTES = 3 * 1024 * 1024

/**
 * Cap on the combined old+new file contents shipped to enable expandable
 * context. Above this we omit contents and the viewer falls back to the
 * (non-expandable) patch render.
 */
const MAX_CONTENTS_BYTES = 3 * 1024 * 1024

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

/**
 * Resolve what HEAD points at. `symbolic-ref` answers with the branch name on
 * a normal (or unborn) branch and exits 1 when detached; detached HEAD then
 * resolves to its short hash.
 */
async function resolveHead(repoPath: string): Promise<{ current: string; detached: boolean }> {
  try {
    const name = (await runGit(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD'], [1])).trim()
    if (name) return { current: name, detached: false }
  } catch {
    /* fall through to detached handling */
  }
  try {
    const short = (await runGit(repoPath, ['rev-parse', '--short', 'HEAD'])).trim()
    return { current: short, detached: true }
  } catch {
    return { current: 'HEAD', detached: true }
  }
}

/** How many recently checked-out branches the switcher's RECENT section shows. */
const RECENT_BRANCH_LIMIT = 5

/**
 * Extract recently checked-out branches from reflog subjects (`%gs` lines like
 * "checkout: moving from feature/x to main"): the checkout *targets*, newest
 * first, deduplicated, kept only when still in `candidates` (so deleted
 * branches and detached-HEAD hashes drop out). Pure + exported for tests.
 */
export function parseRecentBranches(
  reflog: string,
  candidates: ReadonlySet<string>,
  limit = RECENT_BRANCH_LIMIT
): string[] {
  const recent: string[] = []
  for (const line of reflog.split('\n')) {
    // Refnames can never contain spaces, so the trailing token is exact.
    const target = line.match(/^checkout: moving from \S+ to (\S+)$/)?.[1]
    if (!target || !candidates.has(target) || recent.includes(target)) continue
    recent.push(target)
    if (recent.length >= limit) break
  }
  return recent
}

/**
 * The repo's default branch: what origin/HEAD points at, falling back to a
 * local/remote main or master. Null when nothing matches (e.g. a fresh repo
 * with a custom unborn branch).
 */
async function getDefaultBranch(
  repoPath: string,
  local: string[],
  remote: string[]
): Promise<string | null> {
  try {
    const ref = (
      await runGit(repoPath, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], [1])
    ).trim()
    if (ref) return ref.replace(/^origin\//, '')
  } catch {
    /* origin/HEAD not set locally — fall through to the name probe */
  }
  return (
    ['main', 'master'].find((name) => local.includes(name) || remote.includes(`origin/${name}`)) ??
    null
  )
}

export async function getBranches(repoPath: string): Promise<BranchInfo> {
  // One `for-each-ref` enumerates local + remote branches AND marks the
  // checked-out one (`*`). `git branch -v` (what a wrapper library would
  // run) additionally computes ahead/behind for every tracked branch, a rev
  // walk per branch that costs seconds on remote-heavy repos. Fields are
  // NUL-separated; refnames cannot contain NUL or newline, so line-based
  // parsing is exact. `--sort=-committerdate` puts freshly committed branches
  // first — the ordering the switcher wants — at no extra cost.
  const out = await runGit(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(HEAD)%00%(refname)%00%(refname:short)%00%(symref)',
    'refs/heads',
    'refs/remotes'
  ])
  const local: string[] = []
  const remote: string[] = []
  let current = ''
  for (const line of out.split('\n')) {
    if (!line) continue
    const [head, refname, short, symref] = line.split('\0')
    if (symref) continue // e.g. refs/remotes/origin/HEAD — a pointer, not a branch
    if (refname.startsWith('refs/heads/')) {
      local.push(short)
      if (head === '*') current = short
    } else if (refname.startsWith('refs/remotes/')) {
      remote.push(short)
    }
  }
  // No starred local ref: HEAD is unborn (first commit pending) or detached.
  const head = current ? { current, detached: false } : await resolveHead(repoPath)
  const defaultBranch = await getDefaultBranch(repoPath, local, remote)
  const recent = await getRecentBranches(repoPath, local, head.current, defaultBranch)
  return { ...head, local, remote, defaultBranch, recent }
}

/** Recently checked-out local branches, excluding current/default (shown elsewhere). */
async function getRecentBranches(
  repoPath: string,
  local: string[],
  current: string,
  defaultBranch: string | null
): Promise<string[]> {
  // The HEAD reflog records every checkout; 400 entries is weeks of work on an
  // active repo and still a single cheap local read.
  const reflog = await runGit(repoPath, ['reflog', '--format=%gs', '-n', '400']).catch(() => '')
  const candidates = new Set(local)
  candidates.delete(current)
  if (defaultBranch) candidates.delete(defaultBranch)
  return parseRecentBranches(reflog, candidates)
}

/**
 * A repo summary cheap enough to return synchronously on open: just the current
 * branch (one git call), no branch enumeration and no working-tree status. The
 * renderer uses this to switch repos instantly, then fetches the full branch
 * list and status in the background. Counts are left at zero — they aren't
 * surfaced in the UI.
 */
export async function getQuickSummary(repoPath: string): Promise<RepoSummary> {
  const { current, detached } = await resolveHead(repoPath)
  return {
    path: repoPath,
    name: basename(repoPath),
    branch: { current, detached, local: [], remote: [], defaultBranch: null, recent: [] },
    changeCount: 0,
    ahead: 0,
    behind: 0
  }
}

/**
 * Turn a git remote URL into a browsable https web URL, handling the three
 * forms git hands back: scp-like (`git@host:owner/repo.git`), `ssh://` /
 * `git://`, and plain http(s). Returns null when the input can't be turned into
 * something a browser opens (e.g. a local path remote). Pure + exported so it
 * can be unit-tested without a real repo.
 */
export function toWebUrl(remote: string): string | null {
  let url = remote.trim()
  if (!url) return null
  // scp-like: git@github.com:owner/repo.git  →  https://github.com/owner/repo
  const scp = url.match(/^[\w.+-]+@([^:/]+):(.+)$/)
  if (scp) {
    url = `https://${scp[1]}/${scp[2]}`
  } else if (url.startsWith('ssh://')) {
    // ssh://git@host[:port]/owner/repo → drop creds + port, force https
    url = url.replace(/^ssh:\/\/(?:[^@/]+@)?/, 'https://').replace(/^(https:\/\/[^/]+):\d+/, '$1')
  } else if (url.startsWith('git://')) {
    url = `https://${url.slice('git://'.length)}`
  } else if (url.startsWith('http://')) {
    url = `https://${url.slice('http://'.length)}`
  } else if (!url.startsWith('https://')) {
    return null
  }
  url = url.replace(/\.git$/, '')
  // Sanity-check the result looks like https://host/path before handing it off.
  return /^https:\/\/[^/]+\/.+/.test(url) ? url : null
}

/**
 * Resolve the repo's remote to a browsable web URL, preferring `origin` and
 * falling back to the first configured remote. Returns null when the repo has
 * no remote or its URL can't be made browsable.
 */
export async function getRemoteWebUrl(repoPath: string): Promise<string | null> {
  const readUrl = async (remote: string): Promise<string | null> => {
    try {
      return (await runGit(repoPath, ['remote', 'get-url', remote])).trim() || null
    } catch {
      return null
    }
  }
  let raw = await readUrl('origin')
  if (!raw) {
    const first = (await runGit(repoPath, ['remote']).catch(() => ''))
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)[0]
    if (first) raw = await readUrl(first)
  }
  return raw ? toWebUrl(raw) : null
}

// Log fields, NUL-joined: subjects/bodies can contain any byte except NUL, so
// NUL is the only safe field separator. With `-z` git also terminates each
// commit record with NUL, so the whole output is one flat NUL stream parsed
// by fixed field count.
const LOG_FIELDS = ['%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%ar', '%D', '%P']
const LOG_FORMAT = LOG_FIELDS.join('%x00')

/** Parse NUL-delimited `git log --format=LOG_FORMAT` output into commits. */
function parseLog(out: string): Commit[] {
  const fields = out.split('\0')
  const commits: Commit[] = []
  for (let i = 0; i + LOG_FIELDS.length <= fields.length; i += LOG_FIELDS.length) {
    const [hash, shortHash, subject, body, authorName, authorEmail, date, relativeDate, refs] =
      fields.slice(i, i + 9)
    const parents = fields[i + 9]
    commits.push({
      hash,
      shortHash,
      subject,
      body: body.trim(),
      authorName,
      authorEmail,
      date,
      relativeDate,
      refs,
      parents: parents.trim() ? parents.trim().split(' ') : []
    } satisfies Commit)
  }
  return commits
}

export async function getLog(repoPath: string, options: LogOptions = {}): Promise<Commit[]> {
  const { ref, limit = 200, skip = 0, search } = options
  const args = ['log', '-z', `--format=${LOG_FORMAT}`, `--max-count=${limit}`]
  if (skip > 0) args.push(`--skip=${skip}`)
  if (search?.trim()) {
    args.push(`--grep=${search.trim()}`, '-i', '--all-match')
  }
  args.push(ref?.trim() ? ref : 'HEAD')

  return parseLog(await runGit(repoPath, args))
}

/**
 * History of the commits that touched a single file, newest first. `--follow`
 * tracks the file across renames (it requires exactly one pathspec); `-M`
 * enables the rename detection it relies on. `ref` bounds the walk (a commit
 * for a History-tab file, HEAD for a working-tree file).
 */
export async function getFileHistory(
  repoPath: string,
  path: string,
  ref?: string,
  limit = 200
): Promise<Commit[]> {
  const args = [
    'log',
    '-z',
    '--follow',
    '-M',
    `--format=${LOG_FORMAT}`,
    `--max-count=${limit}`,
    ref?.trim() ? ref : 'HEAD',
    '--',
    path
  ]
  return parseLog(await runGit(repoPath, args))
}

/** Git's all-zero sha: blame's marker for an uncommitted working-tree line. */
const BLAME_ZERO_SHA = '0'.repeat(40)

/** Per-commit metadata shared by every line a commit introduced. */
interface BlameCommitInfo {
  authorName: string
  authorEmail: string
  date: string
  summary: string
  filename: string
  previous?: { hash: string; filename: string }
  isBoundary: boolean
}

/** Drop the surrounding angle brackets git wraps around the email field. */
const stripAngles = (s: string): string => s.replace(/^</, '').replace(/>$/, '')

/**
 * Unquote a git path. With `core.quotePath=false` git emits paths raw (UTF-8),
 * only wrapping in double quotes — with C-style escapes — when they contain a
 * quote, backslash, or control character; this reverses that rare case.
 */
function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p
  return p.slice(1, -1).replace(/\\(\\|"|t|n|r|[0-7]{1,3})/g, (_, esc: string) => {
    switch (esc) {
      case '\\':
        return '\\'
      case '"':
        return '"'
      case 't':
        return '\t'
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      default:
        return String.fromCharCode(Number.parseInt(esc, 8))
    }
  })
}

/**
 * Parse `git blame --porcelain` output into one record per line. Porcelain
 * is line-based (newline-delimited — `-z` does not NUL-delimit it), and emits
 * the full commit header only the *first* time a commit appears, then just an
 * abbreviated `<sha> <orig> <final>` header for later lines of that commit;
 * we cache each commit's metadata by sha so repeat lines reuse it (keeps large
 * files cheap). Every line ends with a tab-prefixed content line. Exported for
 * tests.
 */
export function parseBlamePorcelain(out: string): BlameLine[] {
  const lines = out.split('\n')
  const commits = new Map<string, BlameCommitInfo>()
  const result: BlameLine[] = []
  let i = 0
  while (i < lines.length) {
    // Header: "<40-hex sha> <orig-line> <final-line> [<lines-in-group>]".
    const m = lines[i].match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/)
    if (!m) {
      i++
      continue
    }
    const hash = m[1]
    const lineNumber = Number(m[2])
    i++

    // Extended header block — present only the first time this sha is seen.
    let info = commits.get(hash)
    if (!info) {
      const draft: Partial<BlameCommitInfo> = {}
      let isBoundary = false
      while (i < lines.length && !lines[i].startsWith('\t')) {
        const field = lines[i]
        if (field.startsWith('author ')) draft.authorName = field.slice(7)
        else if (field.startsWith('author-mail ')) draft.authorEmail = stripAngles(field.slice(12))
        else if (field.startsWith('author-time '))
          draft.date = new Date(Number(field.slice(12)) * 1000).toISOString()
        else if (field.startsWith('summary ')) draft.summary = field.slice(8)
        else if (field.startsWith('filename ')) draft.filename = unquoteGitPath(field.slice(9))
        else if (field.startsWith('previous ')) {
          const rest = field.slice(9)
          const sp = rest.indexOf(' ')
          draft.previous = { hash: rest.slice(0, sp), filename: unquoteGitPath(rest.slice(sp + 1)) }
        } else if (field === 'boundary') isBoundary = true
        i++
      }
      info = {
        authorName: draft.authorName ?? '',
        authorEmail: draft.authorEmail ?? '',
        date: draft.date ?? '',
        summary: draft.summary ?? '',
        filename: draft.filename ?? '',
        previous: draft.previous,
        isBoundary
      }
      commits.set(hash, info)
    }

    // The tab-prefixed content line closes the record.
    const content = lines[i]?.startsWith('\t') ? lines[i].slice(1) : ''
    i++

    result.push({
      hash,
      shortHash: hash.slice(0, 7),
      authorName: info.authorName,
      authorEmail: info.authorEmail,
      date: info.date,
      summary: info.summary,
      lineNumber,
      content,
      filename: info.filename,
      previous: info.previous,
      isBoundary: info.isBoundary || undefined,
      notCommitted: hash === BLAME_ZERO_SHA || undefined
    })
  }
  // git already emits final-file order; sort defensively so the gutter aligns.
  return result.sort((a, b) => a.lineNumber - b.lineNumber)
}

/**
 * Blame a file: each line annotated with the commit that last touched it.
 * No `ref` blames the working tree (uncommitted lines come back as git's
 * all-zero "Not Committed Yet" sha); a `ref` blames that revision. We force
 * `core.quotePath=false` so non-ASCII paths in the `filename`/`previous`
 * fields arrive raw rather than octal-escaped.
 */
export async function getBlame(
  repoPath: string,
  path: string,
  ref?: string
): Promise<BlameLine[]> {
  const args = ['-c', 'core.quotePath=false', 'blame', '--porcelain']
  if (ref?.trim()) args.push(ref)
  args.push('--', path)
  return parseBlamePorcelain(await runGit(repoPath, args))
}

function parseStatusLetter(letter: string): FileStatus {
  switch (letter[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'added'
    case 'M':
    case 'T':
      return 'modified'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

/** True when an error means `<hash>^` didn't resolve (root commit, no parent). */
const isNoParentError = (e: unknown) =>
  e instanceof Error && /unknown revision|bad revision/i.test(e.message)

/**
 * Parse combined `diff-tree -z --raw --numstat` output (raw records first,
 * then numstat). NUL-delimited, so any filename — unicode, tabs, newlines —
 * parses exactly; without `-z` git C-quotes such paths and the parse breaks.
 * Token layout (NUL-separated):
 *   raw:      `:oldmode newmode oldsha newsha S` `path` (R/C: `src` `dst`)
 *   numstat:  `ins\tdel\tpath`                  (R/C: `ins\tdel\t` `src` `dst`)
 * Exported for tests.
 */
export function parseRawNumstat(out: string): ChangedFile[] {
  const tokens = out.split('\0')
  const files: ChangedFile[] = []
  const byPath = new Map<string, ChangedFile>()
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok) continue
    if (tok.startsWith(':')) {
      const fields = tok.split(' ')
      const status = fields[4] ?? ''
      // Gitlink mode on either side marks a submodule entry (the other side
      // is 000000 when the submodule was added or removed).
      const submodule = fields[0] === ':160000' || fields[1] === '160000' || undefined
      const rename = status.startsWith('R') || status.startsWith('C')
      const oldPath = rename ? tokens[++i] : undefined
      const path = tokens[++i]
      // Dedup guard: a single tree-pair diff yields each path once, but a
      // duplicate would make the file-tree renderer throw.
      if (path && !byPath.has(path)) {
        const file: ChangedFile = {
          path,
          oldPath,
          status: parseStatusLetter(status),
          staged: true,
          submodule
        }
        byPath.set(path, file)
        files.push(file)
      }
      continue
    }
    const m = tok.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s)
    if (!m) continue
    let path = m[3]
    if (!path) {
      // Rename numstat: empty inline path, then src + dst tokens.
      i += 2
      path = tokens[i] ?? ''
    }
    const file = byPath.get(path)
    if (file) {
      const binary = m[1] === '-' && m[2] === '-'
      file.binary = binary
      file.insertions = binary ? undefined : Number(m[1])
      file.deletions = binary ? undefined : Number(m[2])
    }
  }
  // Plain byte sort, matching the snapshot's ordering contract.
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export async function getCommitFiles(repoPath: string, hash: string): Promise<ChangedFile[]> {
  // Diff against the first parent so merge commits report only what the merge
  // introduced on top of the mainline rather than the union of every parent.
  // `diff-tree -m --first-parent` does NOT do this —
  // `-m` emits a section per parent and silently ignores `--first-parent`,
  // producing the union — so we name the two trees explicitly. One spawn
  // carries status AND line counts; root commits (no parent) retry against
  // the empty tree.
  const args = ['diff-tree', '--no-commit-id', '-M', '-r', '-z', '--raw', '--numstat']
  let out: string
  try {
    out = await runGit(repoPath, [...args, `${hash}^`, hash])
  } catch (e) {
    if (!isNoParentError(e)) throw e
    out = await runGit(repoPath, [...args, EMPTY_TREE, hash])
  }
  return parseRawNumstat(out)
}

/** The payload for a diff whose text exceeded `runGit`'s output buffer. */
function tooLargeDiff(base: Omit<DiffPayload, 'patch' | 'binary' | 'notice'>): DiffPayload {
  return { ...base, patch: '', binary: false, notice: 'This diff is too large to display.' }
}

function finalizeDiff(
  payload: Omit<DiffPayload, 'binary' | 'notice'> & { patch: string }
): DiffPayload {
  const { patch } = payload
  const binary = /^Binary files |GIT binary patch/m.test(patch)
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    return {
      ...payload,
      patch: '',
      binary,
      notice: 'This diff is too large to display.'
    }
  }
  // LFS-tracked files diff as pointer text (both sides run through the clean
  // filter) — oid/size churn no user should have to read. Ship the object
  // sizes instead; the viewer renders a dedicated LFS panel.
  const lfs = describeLfsPatch(patch)
  if (lfs) {
    return {
      ...payload,
      patch: '',
      binary: false,
      lfs,
      notice: 'This file is stored with Git LFS — its content lives outside the repository.'
    }
  }
  // Submodule (gitlink) changes diff as "Subproject commit <sha>" plumbing
  // text — ship the structured commit movement instead; the viewer renders a
  // dedicated submodule panel.
  const submodule = describeSubmodulePatch(patch)
  if (submodule) {
    return { ...payload, patch: '', binary: false, submodule }
  }
  if (binary && !patch.includes('@@')) {
    return { ...payload, binary, notice: 'Binary file — no textual diff available.' }
  }
  return { ...payload, binary }
}

/** Read a blob's contents at a ref (`git show <ref>:<path>`); null if absent. */
async function showFile(repoPath: string, ref: string, path: string): Promise<string | null> {
  try {
    return await runGit(repoPath, ['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

/** Read a working-tree file from disk; null if unreadable. */
async function readWorkingFile(repoPath: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, path), 'utf8')
  } catch {
    return null
  }
}

/**
 * Attach full old/new contents to a diff payload so the viewer can render an
 * expandable diff. No-ops (returns the payload unchanged) when either side is
 * unreadable or the combined size exceeds the cap.
 */
function withContents(
  payload: DiffPayload,
  oldContents: string | null,
  newContents: string | null
): DiffPayload {
  if (oldContents == null || newContents == null) return payload
  const size = Buffer.byteLength(oldContents, 'utf8') + Buffer.byteLength(newContents, 'utf8')
  if (size > MAX_CONTENTS_BYTES) return payload
  return { ...payload, oldContents, newContents }
}

export async function getWorkingDiff(
  repoPath: string,
  file: ChangedFile,
  area: DiffArea = 'all'
): Promise<DiffPayload> {
  const status =
    area === 'staged'
      ? (file.indexStatus ?? file.status)
      : area === 'unstaged'
        ? (file.workingStatus ?? file.status)
        : file.status
  const base = { path: file.path, oldPath: file.oldPath, status }
  let patch = ''

  try {
    if (file.status === 'untracked' || (area === 'unstaged' && status === 'untracked')) {
      // Untracked files have no index entry; diff against /dev/null. git returns
      // exit code 1 when the files differ, which is expected here.
      patch = await runGit(
        repoPath,
        ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path],
        [1]
      )
    } else if (area === 'staged') {
      // Index vs HEAD: exactly what `commit` would record for this file.
      const args = ['diff', '--no-color', '--cached', '-M', '--', file.path]
      if (file.oldPath) args.push(file.oldPath)
      patch = await runGit(repoPath, args, [1])
    } else if (area === 'unstaged') {
      // Working tree vs index: what's left to stage.
      patch = await runGit(repoPath, ['diff', '--no-color', '--', file.path], [1])
    } else {
      // Everything tracked: full working-tree state (staged + unstaged) vs HEAD.
      const args = ['diff', '--no-color', 'HEAD', '--', file.path]
      if (file.oldPath) args.push(file.oldPath)
      patch = await runGit(repoPath, args, [1])
    }
  } catch (e) {
    if (e instanceof GitOutputTooLargeError) return tooLargeDiff(base)
    throw e
  }

  const payload = finalizeDiff({ ...base, patch })
  // LFS pointers and submodules own their panels — never treat them as images
  // (the LFS "old side" blob would be pointer text, not pixels).
  if (payload.lfs || payload.submodule) return payload

  // Renderable image: ship both sides as data URLs and let the viewer take
  // over. SVG additionally keeps its text diff (it IS text) so the viewer can
  // offer an Image ⇄ Code toggle; rasters drop the "binary file" notice.
  // Rasters must never ship text contents: a rename-only jpeg diffs to just
  // the rename header (no "Binary files differ" line, binary=false), which
  // would otherwise read as a diffable text file and attach raw image bytes
  // decoded as utf8.
  const mime = imageMimeType(file.path)
  if (mime) {
    const image = await loadWorkingImageSides(repoPath, file, status, area)
    if (image) {
      if (mime === 'image/svg+xml' && !payload.binary && !payload.notice) {
        return { ...(await attachWorkingContents(payload, repoPath, file, status, area)), image }
      }
      return { ...payload, notice: undefined, image }
    }
  }
  if (payload.notice || payload.binary) return payload

  return attachWorkingContents(payload, repoPath, file, status, area)
}

/**
 * Attach the full old/new text contents matching a working diff, so the
 * viewer can expand context. `:0` is the index (stage 0); HEAD is the last
 * commit. The old side of an unstaged diff is the index; everything else
 * diffs from HEAD. No-ops for statuses with no expandable sides.
 */
async function attachWorkingContents(
  payload: DiffPayload,
  repoPath: string,
  file: ChangedFile,
  status: FileStatus,
  area: DiffArea
): Promise<DiffPayload> {
  const oldSideRef = area === 'unstaged' ? ':0' : 'HEAD'
  const newFromIndex = (path: string) => showFile(repoPath, ':0', path)
  let oldContents: string | null
  let newContents: string | null
  switch (status) {
    case 'untracked':
    case 'added':
      oldContents = ''
      newContents =
        area === 'staged'
          ? await newFromIndex(file.path)
          : await readWorkingFile(repoPath, file.path)
      break
    case 'deleted':
      oldContents = await showFile(repoPath, oldSideRef, file.oldPath ?? file.path)
      newContents = ''
      break
    case 'modified':
    case 'renamed':
      oldContents = await showFile(repoPath, oldSideRef, file.oldPath ?? file.path)
      newContents =
        area === 'staged'
          ? await newFromIndex(file.path)
          : await readWorkingFile(repoPath, file.path)
      break
    default:
      // conflicted / ignored: leave non-expandable.
      return payload
  }

  return withContents(payload, oldContents, newContents)
}

export async function getCommitDiff(
  repoPath: string,
  hash: string,
  file: ChangedFile
): Promise<DiffPayload> {
  const base = { path: file.path, oldPath: file.oldPath, status: file.status }

  // Try the first parent directly; only root commits fail, and they retry
  // against the empty tree — one spawn in the common case instead of a
  // rev-parse probe plus the diff.
  const paths = file.oldPath ? [file.path, file.oldPath] : [file.path]
  let hasParent = true
  let patch: string
  try {
    patch = await runGit(
      repoPath,
      ['diff', '--no-color', '-M', `${hash}^`, hash, '--', ...paths],
      [1]
    )
  } catch (e) {
    if (e instanceof GitOutputTooLargeError) return tooLargeDiff(base)
    if (!isNoParentError(e)) throw e
    hasParent = false
    try {
      patch = await runGit(
        repoPath,
        ['diff', '--no-color', '-M', EMPTY_TREE, hash, '--', ...paths],
        [1]
      )
    } catch (e2) {
      if (e2 instanceof GitOutputTooLargeError) return tooLargeDiff(base)
      throw e2
    }
  }
  const payload = finalizeDiff({ ...base, patch })
  if (payload.lfs || payload.submodule) return payload

  // Same image hand-off as working diffs: data-URL sides for the image
  // viewer; only SVG keeps its text diff for the Image ⇄ Code toggle (see
  // getWorkingDiff for why rasters must not ship text contents).
  const mime = imageMimeType(file.path)
  if (mime) {
    const image = await loadCommitImageSides(repoPath, hash, file, hasParent)
    if (image) {
      if (mime === 'image/svg+xml' && !payload.binary && !payload.notice) {
        return { ...(await attachCommitContents(payload, repoPath, hash, file, hasParent)), image }
      }
      return { ...payload, notice: undefined, image }
    }
  }
  if (payload.notice || payload.binary) return payload

  return attachCommitContents(payload, repoPath, hash, file, hasParent)
}

/** Attach the full old/new text contents matching a commit diff. */
async function attachCommitContents(
  payload: DiffPayload,
  repoPath: string,
  hash: string,
  file: ChangedFile,
  hasParent: boolean
): Promise<DiffPayload> {
  const oldContents =
    file.status === 'added' || !hasParent
      ? ''
      : await showFile(repoPath, `${hash}^`, file.oldPath ?? file.path)
  const newContents = file.status === 'deleted' ? '' : await showFile(repoPath, hash, file.path)

  return withContents(payload, oldContents, newContents)
}

// ── Merge preview & conflict sides ───────────────────────────────────────────

/**
 * Parse `git merge-tree --write-tree --name-only --no-messages HEAD <branch>`
 * output: the first line is the would-be tree oid, every following non-empty
 * line a path that would conflict (none on a clean merge). Pure + exported
 * for tests.
 */
export function parseMergeTreeNames(out: string): string[] {
  return out.split('\n').slice(1).filter(Boolean)
}

/**
 * Predict what merging `branch` into HEAD would do, without touching the
 * working tree or index. `merge-tree --write-tree` performs the real merge
 * in memory (writing only loose objects), so the prediction matches what
 * `git merge` will actually find. Requires git ≥ 2.38 — older gits report
 * `unknown` and the merge itself still works.
 */
export async function getMergePreview(repoPath: string, branch: string): Promise<MergePreview> {
  const countOut = await runGit(repoPath, ['rev-list', '--count', `HEAD..${branch}`])
  const commitCount = Number(countOut.trim()) || 0
  if (commitCount === 0) return { outcome: 'up-to-date', conflictedPaths: [], commitCount: 0 }
  try {
    // Exit 1 = "merged with conflicts" — expected, the names tell us which.
    const out = await runGit(
      repoPath,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branch],
      [1]
    )
    const conflictedPaths = parseMergeTreeNames(out)
    return {
      outcome: conflictedPaths.length > 0 ? 'conflicts' : 'clean',
      conflictedPaths,
      commitCount
    }
  } catch {
    return { outcome: 'unknown', conflictedPaths: [], commitCount }
  }
}

/** Number of `<<<<<<<` conflict regions in a working file. Pure + exported for tests. */
export function countConflictMarkers(contents: string): number {
  return contents.split('\n').filter((line) => line.startsWith('<<<<<<<')).length
}

/** Heuristic binary sniff, mirroring git's own: any NUL byte means binary. */
const looksBinary = (contents: string | null) => contents?.includes('\0') ?? false

/**
 * The three versions of a conflicted path for the conflict-resolution panel.
 * Index stage 1 is the common ancestor ("base"), stage 2 "ours" (HEAD),
 * stage 3 "theirs" (the branch being merged); a missing stage means the file
 * doesn't exist on that side (modify/delete, or added on both sides).
 */
export async function getConflictSides(repoPath: string, path: string): Promise<ConflictSides> {
  const [base, ours, theirs, working] = await Promise.all([
    showFile(repoPath, ':1', path),
    showFile(repoPath, ':2', path),
    showFile(repoPath, ':3', path),
    readWorkingFile(repoPath, path)
  ])
  const binary = looksBinary(base) || looksBinary(ours) || looksBinary(theirs)
  const size = (s: string | null) => Buffer.byteLength(s ?? '', 'utf8')
  // The panel renders one pair at a time, so cap each version on its own —
  // two small sides shouldn't lose their diff because the third is huge.
  const cap = (s: string | null) =>
    binary || s === null || size(s) > MAX_CONTENTS_BYTES ? null : s
  return {
    base: cap(base),
    ours: cap(ours),
    theirs: cap(theirs),
    // A missing stage means that side has no version of the file at all —
    // the panel must not mistake "too large to ship" for "deleted".
    oursDeleted: ours === null,
    theirsDeleted: theirs === null,
    markerCount: working === null || binary ? 0 : countConflictMarkers(working),
    binary
  }
}

/** The user's configured merge tool (`merge.tool`), or null when unset. */
export async function getMergeToolName(repoPath: string): Promise<string | null> {
  try {
    const out = (await runGit(repoPath, ['config', '--get', 'merge.tool'])).trim()
    return out || null
  } catch {
    return null
  }
}
