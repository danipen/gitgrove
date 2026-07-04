// Commit/stash-message prompt assembly — pure functions over already-gathered
// context (commit-context.ts does the git reads), so what the model is asked
// is unit-testable byte for byte. The style contract: the repo's own recent
// subjects teach the convention (conventional commits, ticket prefixes, mood)
// so there is no "commit style" setting to configure — the repo is the config.

import type { AiCommitOptions } from '@shared/types'
import type { ChatMessage } from './providers'

/** Everything the prompt needs, gathered by commit-context.ts. */
export interface CommitPromptInput {
  mode: 'commit' | 'amend' | 'stash'
  options: AiCommitOptions
  /** One line per selected file: `status\tpath` (renames `status\told → new`). */
  fileSummary: string
  /** Concatenated (size-capped) unified diffs of the selection. */
  diffs: string
  /** Recent commit subjects, newest first — the repo's message style. */
  recentSubjects: string[]
  /** HEAD's full message, for amend (the message being replaced). */
  previousMessage?: string
}

/** Caps applied while gathering diffs, shared with commit-context.ts. */
export const DIFF_CAPS = {
  /** Per-file patch budget — enough to understand a change, not paste it. */
  perFileBytes: 16 * 1024,
  /** Whole-prompt diff budget. */
  totalBytes: 96 * 1024,
  /** Files diffed individually; beyond this they're listed by name only. */
  maxFiles: 60,
  /** Style examples included from the repo's history. */
  recentSubjects: 30
} as const

/**
 * Trim one patch to `maxBytes`, cutting at a line boundary and marking the
 * cut — a silently truncated diff reads like a complete one and misleads.
 */
export function capPatch(patch: string, maxBytes: number): string {
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) return patch
  let cut = Buffer.from(patch, 'utf8').subarray(0, maxBytes).toString('utf8')
  // A byte cut can split a multi-byte character; drop the mangled tail line.
  cut = cut.slice(0, cut.lastIndexOf('\n') + 1)
  return `${cut}[… diff truncated …]\n`
}

const LENGTH_RULES: Record<AiCommitOptions['length'], string> = {
  short: 'Write ONLY a subject line (at most 65 characters). No body.',
  medium:
    'Write a subject line (at most 65 characters), then a blank line, then a body of 1–3 short sentences — only when the change genuinely needs explaining. Trivial changes get a subject only.',
  long: 'Write a subject line (at most 65 characters), then a blank line, then a thorough body explaining what changed and why. Use short paragraphs or "- " bullets.'
}

const TONE_RULES: Record<AiCommitOptions['tone'], string> = {
  technical:
    'Tone: technical and precise — name the actual functions, files and behaviours involved.',
  formal: 'Tone: formal and neutral, suitable for an enterprise changelog.',
  informal: 'Tone: relaxed and plain-spoken, like a quick note to a teammate.',
  friendly: 'Tone: warm and approachable, still professional.'
}

/** The system + user messages for one generation. */
export function buildCommitPrompt(input: CommitPromptInput): ChatMessage[] {
  const { mode, options } = input

  const rules: string[] = []
  if (mode === 'stash') {
    rules.push(
      'You name work-in-progress stashes in a git client.',
      'Write ONLY one short label (at most 60 characters) describing the state of this unfinished work, e.g. "wip: half-migrated toolbar filters". No quotes, no trailing period.'
    )
  } else {
    rules.push(
      'You write git commit messages in a git client.',
      LENGTH_RULES[options.length],
      'Use the imperative mood for the subject ("Add", "Fix", "Rename" — not "Added").',
      'Describe the change itself, never the act of committing. No quotes around the message, no markdown code fences.'
    )
  }
  rules.push(TONE_RULES[options.tone])
  rules.push(
    options.emojis
      ? 'Include one fitting emoji at the start of the subject line.'
      : 'Do not use emojis.'
  )
  if (input.recentSubjects.length > 0) {
    rules.push(
      'Match the style of this repository’s recent commit subjects (prefixes, ticket ids, capitalization, language):',
      input.recentSubjects.map((s) => `  ${s}`).join('\n')
    )
  }
  rules.push('Answer with the message text only — nothing before or after it.')

  const parts: string[] = []
  if (mode === 'amend' && input.previousMessage) {
    parts.push(
      'The user is amending the last commit. Its current message is:',
      input.previousMessage,
      'Write an updated message covering the original commit AND the additional changes below. Keep whatever from the original message is still accurate.'
    )
  } else if (mode === 'stash') {
    parts.push('Name a stash for these uncommitted changes.')
  } else {
    parts.push('Write the commit message for these staged changes.')
  }
  parts.push(`Files in this ${mode === 'stash' ? 'stash' : 'commit'}:\n${input.fileSummary}`)
  if (input.diffs) parts.push(`Diffs:\n${input.diffs}`)

  return [
    { role: 'system', content: rules.join('\n\n') },
    { role: 'user', content: parts.join('\n\n') }
  ]
}
