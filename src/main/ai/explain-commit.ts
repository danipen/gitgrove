// "Explain this commit" — what changed, why it likely changed, what to watch
// out for. The reader already sees the diff; the answer must add understanding,
// not narrate hunks. Context comes from the lock-free read side (the commit's
// message, file list and capped diffs); prompt assembly is pure and
// unit-testable. Commits are immutable, so the ipc layer caches answers per
// hash+model — this module stays cache-unaware.

import { getCommitDiff, getCommitFiles, getLog } from '../git/read'
import { summarizeFiles } from './commit-context'
import { capPatch } from './commit-prompt'
import type { ChatMessage } from './providers'

/** Everything the prompt needs, gathered by gatherExplainCommitContext. */
export interface ExplainCommitPromptInput {
  shortHash: string
  subject: string
  body: string
  authorName: string
  /** Commit date, ISO — lets the model say "three years ago" honestly. */
  date: string
  /** One line per touched file: `status\tpath (+a −d)`. */
  fileSummary: string
  /** Concatenated (size-capped) diffs of the commit. */
  diffs: string
}

/** Size caps — enough diff to understand the change, bounded for any commit. */
export const EXPLAIN_CAPS = {
  perFileBytes: 12 * 1024,
  totalBytes: 64 * 1024,
  maxFiles: 30
} as const

/** The system + user messages for one commit explanation. */
export function buildExplainCommitPrompt(input: ExplainCommitPromptInput): ChatMessage[] {
  const rules = [
    'You explain git commits inside a git client. The reader is a developer who can already see the diff — add understanding, do not narrate hunks line by line.',
    'Answer in plain text: no markdown headers, no code fences ("- " bullets are fine). Cover, in order: what the commit changes (one or two sentences), why it was likely made (grounded in the message and the code, say "likely" when inferring), and anything to watch out for — behaviour changes, risky spots, follow-ups. Omit the watch-out part when there is genuinely none.',
    'At most 120 words. Never invent motives the message and diff cannot support.'
  ]

  const meta = [
    `Commit ${input.shortHash} by ${input.authorName} on ${input.date}.`,
    `Message:\n${input.body ? `${input.subject}\n\n${input.body}` : input.subject}`,
    `Files:\n${input.fileSummary}`
  ]
  if (input.diffs) meta.push(`Diffs:\n${input.diffs}`)

  return [
    { role: 'system', content: rules.join('\n\n') },
    { role: 'user', content: `Explain this commit.\n\n${meta.join('\n\n')}` }
  ]
}

export async function gatherExplainCommitContext(
  repoPath: string,
  hash: string
): Promise<ExplainCommitPromptInput> {
  // The commit itself and its file list, in parallel — both lock-free reads.
  const [log, files] = await Promise.all([
    getLog(repoPath, { ref: hash, limit: 1 }),
    getCommitFiles(repoPath, hash)
  ])
  const commit = log[0]
  if (!commit) throw new Error('That commit could not be read.')

  const pieces: string[] = []
  let budget = EXPLAIN_CAPS.totalBytes
  const textFiles = files.filter((f) => !f.binary && !f.submodule)
  for (const file of textFiles.slice(0, EXPLAIN_CAPS.maxFiles)) {
    if (budget <= 0) break
    try {
      const payload = await getCommitDiff(repoPath, hash, file)
      if (payload.binary || payload.lfs || payload.submodule || !payload.patch) continue
      const capped = capPatch(payload.patch, Math.min(EXPLAIN_CAPS.perFileBytes, budget))
      budget -= Buffer.byteLength(capped, 'utf8')
      pieces.push(capped)
    } catch {
      // An unreadable diff contributes nothing — the summary still names it.
    }
  }

  return {
    shortHash: commit.shortHash,
    subject: commit.subject,
    body: commit.body,
    authorName: commit.authorName,
    date: commit.date,
    fileSummary: summarizeFiles(files) || '(no files changed)',
    diffs: pieces.join('\n')
  }
}
