// Integrating histories: merge, rebase, cherry-pick, revert, reset, and the
// continue/abort/skip controls for whatever multi-step operation is in flight.
// Conflicts come back as data ('conflicts'), never as a thrown error — stopping
// to resolve them is a normal part of the workflow.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MergeOutcome, RepoOpKind, ResetMode } from '@shared/types'
import { run, runOnce, runOnceWithRetry, runRead } from '../exec'
import { withUndo } from '../undo'
import { hasUnmergedEntries } from './internal'

/**
 * Locale-independent "is `ref` already contained in `head`" probe. Exit 1
 * (not an ancestor) is expected; any other failure (e.g. an unresolvable ref)
 * reports false so the operation itself surfaces its own, better error.
 */
async function isAncestor(repoPath: string, ref: string, head: string): Promise<boolean> {
  try {
    await runRead(repoPath, ['merge-base', '--is-ancestor', ref, head])
    return true
  } catch {
    return false
  }
}

/**
 * Merge `branch` into HEAD. Conflicts come back as data ('conflicts'), never
 * as a thrown error — stopping to resolve them is a normal part of merging.
 * `squash` stages the combined result without committing (the user reviews
 * and commits from the composer).
 */
export async function merge(
  repoPath: string,
  branch: string,
  opts: { squash?: boolean } = {}
): Promise<MergeOutcome> {
  // Probe first: git's "Already up to date." is success output the caller
  // would otherwise have to string-match (and it's localized).
  if (await isAncestor(repoPath, branch, 'HEAD')) return 'up-to-date'
  const args = opts.squash ? ['merge', '--squash', branch] : ['merge', '--no-edit', branch]
  // A squash merge or a conflict stop never moves HEAD, so withUndo records
  // nothing for them (correct: squash just stages, a conflict is aborted, not
  // undone). Only a real merge commit / fast-forward leaves an undo point.
  let outcome: MergeOutcome = 'completed'
  await withUndo(
    repoPath,
    {
      kind: 'merge',
      label: ({ currentBranch }) => `Merged ${branch} into ${currentBranch ?? 'HEAD'}`
    },
    async () => {
      try {
        await runOnceWithRetry(repoPath, ['-c', 'core.editor=true', ...args])
      } catch (e) {
        if (await hasUnmergedEntries(repoPath)) {
          outcome = 'conflicts'
          return
        }
        throw e
      }
    }
  )
  return outcome
}

/** Rebase HEAD onto `onto`. Same conflicts-as-data contract as `merge`. */
export async function rebase(repoPath: string, onto: string): Promise<MergeOutcome> {
  if (await isAncestor(repoPath, onto, 'HEAD')) return 'up-to-date'
  // A rebase that stops on conflicts may have applied some commits before
  // stopping, so withUndo can record a partial undo point — harmless: it stays
  // hidden behind the in-progress conflict banner and self-cleans once the
  // rebase is continued or aborted (HEAD then no longer matches it).
  let outcome: MergeOutcome = 'completed'
  await withUndo(
    repoPath,
    {
      kind: 'rebase',
      label: ({ currentBranch }) => `Rebased ${currentBranch ?? 'HEAD'} onto ${onto}`
    },
    async () => {
      try {
        await runOnceWithRetry(repoPath, ['-c', 'core.editor=true', 'rebase', onto])
      } catch (e) {
        if (await hasUnmergedEntries(repoPath)) {
          outcome = 'conflicts'
          return
        }
        // A rebase can also stop without unmerged entries (e.g. dirty tree
        // pre-checks abort before starting) — only an in-flight rebase counts.
        try {
          await runRead(repoPath, ['rev-parse', '-q', '--verify', 'REBASE_HEAD'])
          outcome = 'conflicts'
          return
        } catch {
          throw e
        }
      }
    }
  )
  return outcome
}

/**
 * Conclude an in-progress merge as a regular commit: stage everything (the
 * working tree IS the merge result once conflicts are resolved) and commit
 * with the user's message. MERGE_HEAD makes git record the merge parents —
 * this is exactly `merge --continue`, but with the message the user wrote in
 * the composer instead of an editor round-trip.
 */
export async function commitMerge(repoPath: string, message: string): Promise<void> {
  await withUndo(
    repoPath,
    {
      kind: 'merge',
      label: ({ currentBranch }) => `Completed merge on ${currentBranch ?? 'HEAD'}`
    },
    async () => {
      await runOnce(repoPath, ['add', '-A'])
      await runOnce(repoPath, ['commit', '-F', '-'], { input: message })
    }
  )
}

/**
 * The merge message git prepared (MERGE_MSG) with its comment lines dropped,
 * used to pre-fill the composer while a merge is in progress. Empty when no
 * merge is in flight.
 */
export async function mergeMessage(repoPath: string): Promise<string> {
  try {
    const gitDir = (await runRead(repoPath, ['rev-parse', '--absolute-git-dir'])).trim()
    const raw = await readFile(join(gitDir, 'MERGE_MSG'), 'utf8')
    return raw
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .replace(/\n+$/, '')
  } catch {
    return ''
  }
}

export async function cherryPick(repoPath: string, hash: string): Promise<void> {
  // A cherry-pick that stops on conflicts doesn't move HEAD, so no undo point is
  // recorded for it (its abort lives in the conflict banner).
  await withUndo(
    repoPath,
    { kind: 'cherry-pick', label: `Cherry-picked ${hash.slice(0, 7)}` },
    () => runOnceWithRetry(repoPath, ['cherry-pick', hash])
  )
}

export async function revertCommit(repoPath: string, hash: string): Promise<void> {
  await withUndo(repoPath, { kind: 'revert', label: `Reverted ${hash.slice(0, 7)}` }, () =>
    runOnceWithRetry(repoPath, ['revert', '--no-edit', hash])
  )
}

export async function reset(repoPath: string, hash: string, mode: ResetMode): Promise<void> {
  await withUndo(
    repoPath,
    { kind: 'reset', label: ({ currentBranch }) => `Reset ${currentBranch ?? 'HEAD'}` },
    () => runOnceWithRetry(repoPath, ['reset', `--${mode}`, hash])
  )
}

/**
 * Continue or abort whatever multi-step operation is in flight. `core.editor=
 * true` accepts git's prepared message without opening an editor.
 */
export async function continueOp(repoPath: string, op: RepoOpKind): Promise<void> {
  const sub =
    op === 'merging'
      ? ['merge', '--continue']
      : op === 'rebasing'
        ? ['rebase', '--continue']
        : op === 'cherry-picking'
          ? ['cherry-pick', '--continue']
          : ['revert', '--continue']
  await run(repoPath, ['-c', 'core.editor=true', ...sub])
}

export async function abortOp(repoPath: string, op: RepoOpKind): Promise<void> {
  const sub =
    op === 'merging'
      ? ['merge', '--abort']
      : op === 'rebasing'
        ? ['rebase', '--abort']
        : op === 'cherry-picking'
          ? ['cherry-pick', '--abort']
          : ['revert', '--abort']
  await run(repoPath, sub)
}

/** Skip the current commit of an in-progress rebase. */
export async function skipRebaseCommit(repoPath: string): Promise<void> {
  await run(repoPath, ['rebase', '--skip'])
}
