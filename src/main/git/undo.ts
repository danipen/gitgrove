// One-step undo of the last history-changing operation. GitGrove records a
// tiny "undo point" before each operation that moves the current branch's tip
// (commit, amend, merge, rebase, cherry-pick, revert, reset); undo restores the
// tip to where it was — never losing uncommitted work. This is git's own
// ORIG_HEAD/reflog concept, made precise, labelled and one-click.
//
// The record lives in `<git-dir>/gitgrove/undo.json` (per worktree — each has
// its own HEAD), mirroring how write.ts records its auto-stash metadata. It is
// single-level and self-cleaning: a record is only honoured while the branch
// tip still equals its `postSha`, so any later operation makes the undo
// disappear, and undoing or going stale deletes the file.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { UndoableKind, UndoRecord, UndoResult, UndoSnapshot } from '@shared/types'
import { enqueue, runOnce, runRead } from './exec'

/** Locale-proof env so `git reset --keep`'s refusal text is matchable. */
const ENGLISH = { LC_ALL: 'C' }

/** Cache of repo path → absolute git dir (stable for the life of a repo). */
const gitDirCache = new Map<string, string>()

async function undoFilePath(repoPath: string): Promise<string> {
  let dir = gitDirCache.get(repoPath)
  if (!dir) {
    dir = (await runRead(repoPath, ['rev-parse', '--absolute-git-dir'])).trim()
    if (!isAbsolute(dir)) dir = join(repoPath, dir)
    gitDirCache.set(repoPath, dir)
  }
  return join(dir, 'gitgrove', 'undo.json')
}

/** The current branch tip's full sha, or null when HEAD is unborn (no commits). */
async function headSha(repoPath: string): Promise<string | null> {
  try {
    return (await runOnce(repoPath, ['rev-parse', '--verify', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

/** The current branch name, or null when HEAD is detached. */
async function currentBranch(repoPath: string): Promise<string | null> {
  try {
    return (await runOnce(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

/** Full message (%B) of a commit, trimmed of trailing newlines; '' on failure. */
async function commitMessage(repoPath: string, sha: string): Promise<string> {
  try {
    return (await runOnce(repoPath, ['log', '-1', '--format=%B', sha])).replace(/\n+$/, '')
  } catch {
    return ''
  }
}

async function readUndoRecord(repoPath: string): Promise<UndoRecord | null> {
  try {
    const raw = await readFile(await undoFilePath(repoPath), 'utf8')
    const record = JSON.parse(raw) as UndoRecord
    // Guard against a hand-edited / partial file: postSha and kind are the two
    // fields every code path depends on.
    if (typeof record.postSha === 'string' && typeof record.kind === 'string') return record
    return null
  } catch {
    return null
  }
}

async function writeUndoRecord(repoPath: string, record: UndoRecord): Promise<void> {
  const file = await undoFilePath(repoPath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(record), 'utf8')
}

async function clearUndoRecord(repoPath: string): Promise<void> {
  await rm(await undoFilePath(repoPath), { force: true }).catch(() => {})
}

/** Context handed to a label builder so it can name the branch the op ran on. */
export interface UndoLabelContext {
  currentBranch: string | null
}

interface UndoSpec {
  kind: UndoableKind
  /** Banner label, or a builder when it needs the current branch name. */
  label: string | ((ctx: UndoLabelContext) => string)
  /** Capture the resulting commit's message for composer refill (commit/amend). */
  captureMessage?: boolean
}

/**
 * Run a history-changing git operation and record an undo point for it, as one
 * atomic step on the write queue: capture the branch tip before `op` runs and,
 * once it has actually moved HEAD, write the undo record. `op` MUST use the
 * queue-free `runOnce` (it already holds the queue here) — calling `run` would
 * re-enter the per-repo write queue and deadlock.
 *
 * Operations that don't move HEAD (an up-to-date or squash merge, a conflict
 * that stops before committing) record nothing — there's nothing to undo, and
 * the no-movement guard handles that for free.
 */
export async function withUndo<T>(
  repoPath: string,
  spec: UndoSpec,
  op: () => Promise<T>
): Promise<T> {
  return enqueue(repoPath, async () => {
    const preSha = await headSha(repoPath)
    const branch = typeof spec.label === 'function' ? await currentBranch(repoPath) : null
    const result = await op()
    const postSha = await headSha(repoPath)
    if (postSha && postSha !== preSha) {
      await writeUndoRecord(repoPath, {
        kind: spec.kind,
        branch,
        preSha,
        postSha,
        label:
          typeof spec.label === 'function' ? spec.label({ currentBranch: branch }) : spec.label,
        message: spec.captureMessage ? await commitMessage(repoPath, postSha) : undefined,
        at: new Date().toISOString()
      })
    }
    return result
  })
}

/** One-liner shown in the success toast after an undo. */
function undoNotice(kind: UndoableKind): string {
  switch (kind) {
    case 'commit':
      return 'Commit undone — your changes are back, ready to recommit.'
    case 'amend':
      return 'Amend undone — your previous commit is back.'
    case 'merge':
      return 'Merge undone.'
    case 'rebase':
    case 'rebase-interactive':
      return 'Rebase undone.'
    case 'cherry-pick':
      return 'Cherry-pick undone.'
    case 'revert':
      return 'Revert undone.'
    case 'reset':
      return 'Reset undone.'
  }
}

/**
 * Restore the branch tip to `sha` while preserving uncommitted work. `--keep`
 * is purpose-built for this: it resets HEAD/index and updates the working tree
 * for files that differ, but refuses (a clean abort, no changes made) when that
 * would clobber local modifications — so undoing a merge/rebase is never
 * destructive. Translate only that refusal into actionable copy; surface any
 * other failure as-is.
 */
async function restoreTip(repoPath: string, sha: string): Promise<void> {
  try {
    await runOnce(repoPath, ['reset', '--keep', sha], { env: ENGLISH })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/not uptodate|overwritten|cannot|local changes/i.test(message)) {
      throw new Error(
        'You have uncommitted changes that undoing this would overwrite. ' +
          'Commit or stash them first, then undo.'
      )
    }
    throw e
  }
}

/**
 * Undo the last recorded operation. Refuses (a friendly "nothing to undo") when
 * there's no valid record — including when the branch has moved on since, in
 * which case the stale record is cleaned up. Runs on the write queue so it can't
 * race a concurrent mutation.
 */
export async function undo(repoPath: string): Promise<UndoResult> {
  return enqueue(repoPath, async () => {
    const record = await readUndoRecord(repoPath)
    const head = await headSha(repoPath)
    if (!record || record.postSha !== head) {
      await clearUndoRecord(repoPath)
      throw new Error('There is nothing to undo.')
    }

    if (record.kind === 'commit' && record.preSha === null) {
      // Undoing the very first commit: there is no parent to reset to. Make the
      // branch unborn again and drop the index entries, so the files return to
      // exactly their pre-commit (untracked) state.
      await runOnce(repoPath, ['update-ref', '-d', 'HEAD'])
      await runOnce(repoPath, ['rm', '--cached', '-r', '-q', '.']).catch(() => {})
    } else if (record.kind === 'commit') {
      // The committed changes return to the working tree as uncommitted edits.
      await runOnce(repoPath, ['reset', '--mixed', record.preSha as string])
    } else if (record.kind === 'amend') {
      // Restore the pre-amend commit intact; the amended-in changes return to
      // the index. `--soft` keeps the original commit and touches nothing else.
      await runOnce(repoPath, ['reset', '--soft', record.preSha as string])
    } else {
      // merge / rebase / rebase-interactive / cherry-pick / revert / reset:
      // restore the branch tip, preserving any uncommitted work.
      await restoreTip(repoPath, record.preSha as string)
    }

    await clearUndoRecord(repoPath)
    return {
      kind: record.kind,
      message: record.kind === 'commit' || record.kind === 'amend' ? record.message : undefined,
      notice: undoNotice(record.kind)
    }
  })
}

/**
 * Human relative time for the banner, e.g. "just now", "2 minutes ago". Coarse
 * on purpose — the banner is short-lived and the exact second never matters.
 * Pure + exported for tests.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * Build the renderer's undo affordance from the recorded undo point, validated
 * against the live HEAD. Returns null (no banner) when there's no record or the
 * branch has moved on since — leaving the stale file for the next operation to
 * overwrite, or for `undo` to clean up. `headOid`/`upstream` come from the
 * status snapshot the caller already has, so this adds at most one cheap
 * ancestor probe (only when the undone history is on an upstream).
 */
export async function readUndoSnapshot(
  repoPath: string,
  headOid: string,
  upstream: string | null
): Promise<UndoSnapshot | null> {
  const record = await readUndoRecord(repoPath)
  if (!record || record.postSha !== headOid) return null
  let pushed = false
  if (upstream) {
    pushed = await runRead(repoPath, [
      'merge-base',
      '--is-ancestor',
      record.postSha,
      upstream
    ]).then(
      () => true,
      () => false
    )
  }
  return {
    kind: record.kind,
    label: record.label,
    relativeTime: relativeTime(record.at),
    pushed
  }
}
