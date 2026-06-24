// The checkbox commit model: checkboxes are pure renderer state and never
// touch git — this module turns a selection into a commit at commit time.

import { runOnce, runRead } from '../exec'
import { withUndo } from '../undo'
import { isUnbornHead } from './internal'

/** What the renderer's checkboxes selected for the next commit. */
export interface CommitSelectionPayload {
  amend?: boolean
  /** Every (non-conflicted) changed file is fully included. */
  all: boolean
  /** Fully included paths, when not `all`. */
  paths: string[]
  /** Standalone hunk patches (HEAD → working tree) for partially included files. */
  patches: string[]
}

/** Banner label for an undoable commit/amend, naming its summary. */
function commitUndoLabel(amend: boolean, message: string): string {
  const summary = message.split('\n')[0].trim()
  const short = summary.length > 50 ? `${summary.slice(0, 49)}…` : summary || 'commit'
  return amend ? `Amended “${short}”` : `Committed “${short}”`
}

/**
 * The checkbox commit model: checkboxes never touch git — this one call
 * does, at commit time, as a single atomic step on the write queue (wrapped so
 * the commit can be undone — see git/undo.ts):
 *
 *   1. reset the index to HEAD (the index is scratch space in this model);
 *   2. `git add -A` the fully included paths (NUL pathspecs over stdin, so a
 *      ten-thousand-file selection is one spawn, no argv limits);
 *   3. `git apply --cached` each selected-hunk patch — their old sides are
 *      HEAD coordinates, so they apply cleanly to the just-reset index;
 *   4. `git commit -F -` (signing follows the user's git config).
 */
export async function commitSelection(
  repoPath: string,
  message: string,
  sel: CommitSelectionPayload
): Promise<void> {
  const amend = sel.amend === true
  await withUndo(
    repoPath,
    // Plain commit: capture the new message so undo refills the composer. Amend:
    // undo restores the original commit intact, so no message capture is needed.
    {
      kind: amend ? 'amend' : 'commit',
      label: commitUndoLabel(amend, message),
      captureMessage: !amend
    },
    async () => {
      try {
        await runOnce(repoPath, ['reset', '-q'])
      } catch (e) {
        if (!isUnbornHead(e)) throw e
      }
      if (sel.all) {
        await runOnce(repoPath, ['add', '-A'])
      } else if (sel.paths.length > 0) {
        await runOnce(repoPath, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: sel.paths.join('\0')
        })
      }
      for (const patch of sel.patches) {
        await runOnce(repoPath, ['apply', '--cached', '--whitespace=nowarn', '-'], {
          input: patch.endsWith('\n') ? patch : `${patch}\n`
        })
      }
      const args = ['commit', '-F', '-']
      if (amend) args.push('--amend')
      await runOnce(repoPath, args, { input: message })
    }
  )
}

/** Full message (%B) of HEAD, used to pre-fill the composer when amending. */
export async function lastCommitMessage(repoPath: string): Promise<string> {
  try {
    return (await runRead(repoPath, ['log', '-1', '--format=%B'])).replace(/\n+$/, '')
  } catch {
    return ''
  }
}
