// Gathers what the commit-message prompt needs from the repository — the
// "RAG" is git itself. Runs entirely on the lock-free read side (getWorkingDiff
// / getLog), so a generation never blocks or queues behind a write. All output
// is size-capped (see DIFF_CAPS): a 90k-file selection must produce a bounded
// prompt, not an unbounded one.

import type { AiCommitRequest, ChangedFile } from '@shared/types'
import { getLog, getWorkingDiff } from '../git/read'
import { capPatch, type CommitPromptInput, DIFF_CAPS } from './commit-prompt'

/** `status\tpath` per file — cheap orientation even for files whose diff
 *  didn't fit the budget (binary, huge, or beyond maxFiles). */
export function summarizeFiles(files: ChangedFile[]): string {
  return files
    .map((f) => {
      const name = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
      const counts =
        f.insertions !== undefined || f.deletions !== undefined
          ? ` (+${f.insertions ?? 0} −${f.deletions ?? 0})`
          : ''
      return `${f.status}\t${name}${counts}`
    })
    .join('\n')
}

export async function gatherCommitContext(
  repoPath: string,
  request: AiCommitRequest
): Promise<CommitPromptInput> {
  const textFiles = request.files.filter((f) => !f.binary && !f.submodule)

  // Hunk patches of partially included files first: they're already exact
  // (they ARE what will be committed), and they cost no git call.
  const pieces: string[] = []
  let budget = DIFF_CAPS.totalBytes
  const take = (patch: string) => {
    if (budget <= 0 || !patch) return
    const capped = capPatch(patch, Math.min(DIFF_CAPS.perFileBytes, budget))
    budget -= Buffer.byteLength(capped, 'utf8')
    pieces.push(capped)
  }
  for (const patch of request.patches) take(patch)

  // Fully included files: read their HEAD → working-tree diffs, a bounded
  // number of them, until the budget runs out. The remainder still appears in
  // the file summary, so the model knows the commit is bigger than its diffs.
  for (const file of textFiles.slice(0, DIFF_CAPS.maxFiles)) {
    if (budget <= 0) break
    try {
      const payload = await getWorkingDiff(repoPath, file, 'all')
      if (!payload.binary && !payload.lfs && !payload.submodule) take(payload.patch)
    } catch {
      // A file that can't be diffed (racing deletion, permissions) simply
      // contributes no diff — the summary line still names it.
    }
  }

  // The repo's own subjects are the style guide (skip while amending HEAD's
  // message would echo itself into the examples — it's passed separately).
  let recentSubjects: string[] = []
  let previousMessage: string | undefined
  try {
    const log = await getLog(repoPath, { limit: DIFF_CAPS.recentSubjects })
    recentSubjects = log.map((c) => c.subject)
    if (request.mode === 'amend' && log[0]) {
      previousMessage = log[0].body ? `${log[0].subject}\n\n${log[0].body}` : log[0].subject
      recentSubjects = recentSubjects.slice(1)
    }
  } catch {
    // An unborn HEAD has no history — the prompt just carries no examples.
  }

  return {
    mode: request.mode,
    options: request.options,
    fileSummary: summarizeFiles(request.files) || '(no files — message-only amend)',
    diffs: pieces.join('\n'),
    recentSubjects,
    previousMessage
  }
}
