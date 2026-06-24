// The fast repo snapshot: everything the renderer needs after any change, in
// (almost) a single git invocation — the lever that keeps refreshes fast on
// 100k-file repositories.
//
//   git status --untracked-files=all --branch --porcelain=2 -z
//
// returns the changed files AND the current branch, upstream, and
// ahead/behind counts as `# branch.*` headers — replacing what used to take a
// status call, two branch enumerations, `rev-parse @{u}` and a full
// `rev-list --left-right --count` graph walk. Merge/rebase/cherry-pick state
// comes from cheap filesystem probes inside the git dir (no spawns), and the
// conflicted-file count falls out of the status entries for free. The only
// extra spawns are `git remote` (reads .git/config) and `git stash list`.

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ChangedFile, FileStatus, RepoOpKind, RepoSnapshot, RepoState } from '@shared/types'
import { PERF } from './perf'
import { runGit } from './read'
import { readUndoSnapshot } from './undo'
import { listStashes } from './write'

/** Parsed `# branch.*` headers from porcelain v2. */
export interface StatusHeaders {
  /** Current branch name, or null when detached/unborn reports `(detached)`. */
  branch: string | null
  /** Abbreviated HEAD oid (empty on an unborn branch). */
  oid: string
  upstream: string | null
  ahead: number
  behind: number
}

export interface ParsedStatus {
  headers: StatusHeaders
  files: ChangedFile[]
  conflictedCount: number
}

function mapCode(code: string): FileStatus {
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    default:
      return 'modified'
  }
}

/**
 * Parse `git status --branch --porcelain=2 -z` output. Exported for tests.
 *
 * Record shapes (NUL-separated; renames carry the original path as an extra
 * NUL-separated field):
 *   `# key value`
 *   `1 XY sub mH mI mW hH hI <path>`
 *   `2 XY sub mH mI mW hH hI Xscore <path>` NUL `<origPath>`
 *   `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`
 *   `? <path>` / `! <path>`
 */
export function parsePorcelainV2(out: string): ParsedStatus {
  const headers: StatusHeaders = { branch: null, oid: '', upstream: null, ahead: 0, behind: 0 }
  const files: ChangedFile[] = []
  let conflictedCount = 0

  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    const kind = rec[0]

    if (kind === '#') {
      const [, key, ...rest] = rec.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.head') headers.branch = value === '(detached)' ? null : value
      else if (key === 'branch.oid') headers.oid = value === '(initial)' ? '' : value
      else if (key === 'branch.upstream') headers.upstream = value
      else if (key === 'branch.ab') {
        const m = value.match(/\+(\d+) -(\d+)/)
        if (m) {
          headers.ahead = Number(m[1])
          headers.behind = Number(m[2])
        }
      }
      continue
    }

    if (kind === '?') {
      files.push({
        path: rec.slice(2),
        status: 'untracked',
        staged: false,
        workingStatus: 'untracked'
      })
      continue
    }
    if (kind === '!') continue

    if (kind === 'u') {
      // Unmerged: `u XY sub m1 m2 m3 mW h1 h2 h3 path` — path is field 10.
      const fields = rec.split(' ')
      const path = fields.slice(10).join(' ')
      files.push({
        path,
        status: 'conflicted',
        staged: false,
        workingStatus: 'conflicted',
        submodule: fields[2]?.startsWith('S') || undefined
      })
      conflictedCount++
      continue
    }

    if (kind === '1' || kind === '2') {
      const fields = rec.split(' ')
      const xy = fields[1]
      // The sub field is `N...` for ordinary files, `S<c><m><u>` for
      // submodules — the one bit the changes list needs to render a gitlink
      // entry as a submodule instead of pretending it's a file.
      const submodule = fields[2]?.startsWith('S') || undefined
      const index = xy[0] === '.' ? ' ' : xy[0]
      const working = xy[1] === '.' ? ' ' : xy[1]
      // Ordinary entries: path starts at field 8. Renames have an extra
      // `Xscore` field, so the path starts at field 9 and the original path
      // follows as the next NUL record.
      const pathFieldStart = kind === '1' ? 8 : 9
      const path = fields.slice(pathFieldStart).join(' ')
      let oldPath: string | undefined
      if (kind === '2') {
        i++
        oldPath = records[i]
      }

      const staged = index !== ' '
      const unstaged = working !== ' '
      files.push({
        path,
        oldPath,
        status: mapCode(index !== ' ' ? index : working),
        staged,
        partiallyStaged: staged && unstaged,
        indexStatus: staged ? mapCode(index) : undefined,
        workingStatus: unstaged ? mapCode(working) : undefined,
        submodule
      })
    }
  }

  return { headers, files, conflictedCount }
}

// ── Repo op state via filesystem probes (no git spawns) ─────────────────────

/** Cache of repo path → absolute git dir (stable for the life of a repo). */
const gitDirCache = new Map<string, string>()

async function getGitDir(repoPath: string): Promise<string> {
  let dir = gitDirCache.get(repoPath)
  if (!dir) {
    dir = (await runGit(repoPath, ['rev-parse', '--absolute-git-dir'])).trim()
    if (!isAbsolute(dir)) dir = join(repoPath, dir)
    gitDirCache.set(repoPath, dir)
  }
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readRepoState(repoPath: string, conflictedCount: number): Promise<RepoState> {
  const gitDir = await getGitDir(repoPath)
  let op: RepoOpKind | null = null
  const rebasing =
    (await exists(join(gitDir, 'rebase-merge'))) || (await exists(join(gitDir, 'rebase-apply')))
  if (rebasing) {
    op = 'rebasing'
  } else if (await exists(join(gitDir, 'MERGE_HEAD'))) op = 'merging'
  else if (await exists(join(gitDir, 'CHERRY_PICK_HEAD'))) op = 'cherry-picking'
  else if (await exists(join(gitDir, 'REVERT_HEAD'))) op = 'reverting'

  let detail: string | undefined
  if (op === 'merging') {
    try {
      detail = (await readFile(join(gitDir, 'MERGE_MSG'), 'utf8')).split('\n')[0]
    } catch {
      /* optional */
    }
  }
  return { op, detail, conflictedCount }
}

// ── The snapshot ─────────────────────────────────────────────────────────────

export async function getRepoSnapshot(repoPath: string): Promise<RepoSnapshot> {
  const t0 = performance.now()
  // One status spawn carries files + branch + upstream + ahead/behind; the
  // remote list and stashes are cheap config/reflog reads, run concurrently.
  const [statusOut, remotesOut, stashes] = await Promise.all([
    runGit(repoPath, ['status', '--untracked-files=all', '--branch', '--porcelain=2', '-z']),
    runGit(repoPath, ['remote']).catch(() => ''),
    listStashes(repoPath)
  ])
  const tGit = performance.now()

  const { headers, files, conflictedCount } = parsePorcelainV2(statusOut)
  if (PERF) {
    const ms = (n: number) => `${n.toFixed(0)}ms`
    console.log(
      `[snapshot] git=${ms(tGit - t0)} parse=${ms(performance.now() - tGit)} files=${files.length}`
    )
  }
  const state = await readRepoState(repoPath, conflictedCount)
  // The one-step undo for the last operation, validated against the live HEAD
  // (cheap: a small file read, plus one ancestor probe only when an undo point
  // sits on an upstream branch).
  const undo = await readUndoSnapshot(repoPath, headers.oid, headers.upstream)
  // Sort here, once, with a plain byte comparator — the renderer treats the
  // list as display-ready and never re-sorts (locale-aware sorting is not
  // worth seconds of work on 90k paths).
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    files,
    branch: headers.branch ?? (headers.oid ? headers.oid.slice(0, 7) : 'HEAD'),
    detached: headers.branch === null && headers.oid !== '',
    upstream: headers.upstream,
    ahead: headers.ahead,
    behind: headers.behind,
    remotes: remotesOut
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean),
    state,
    stashes,
    undo,
    statusMs: Math.round(tGit - t0)
  }
}
