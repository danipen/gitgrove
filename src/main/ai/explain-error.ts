// The error explainer: git's stderr ("non-fast-forward", "refusing to merge
// unrelated histories") becomes one calm human sentence plus the single most
// likely next step. Deliberately zero git calls: the repo situation arrives
// from the renderer's already-loaded state, because an explainer that queues
// behind the very operation that just failed would explain nothing, late.
// Pure prompt assembly — unit-testable byte for byte.

import type { AiExplainErrorRequest } from '@shared/types'
import type { ChatMessage } from './providers'

/** Errors are usually short; a runaway stderr dump must still bound the prompt. */
const MAX_ERROR_BYTES = 4 * 1024

/** The system + user messages for one error explanation. */
export function buildExplainErrorPrompt(request: AiExplainErrorRequest): ChatMessage[] {
  const rules = [
    'You explain git failures inside GitGrove, a git desktop client with Pull, Push, Fetch, branch switching, merging, rebasing, stashing and conflict resolution built in.',
    'Answer with at most 3 short sentences of plain text: first what happened, in everyday words a developer who is not a git expert understands; then the single most likely next step. Prefer naming the client action ("pull first, then push") over raw git commands; give a command only when there is no simpler way.',
    'No markdown, no lists, no apologies, no "it seems". If the error is genuinely ambiguous, say what to check first.'
  ]

  const situation: string[] = []
  if (request.branch) situation.push(`On branch "${request.branch}".`)
  if (request.upstream !== undefined) {
    situation.push(
      request.upstream === null
        ? 'The branch has no upstream.'
        : `Upstream is ${request.upstream} (${request.ahead ?? 0} ahead, ${request.behind ?? 0} behind).`
    )
  }
  // opState arrives as a progressive ("merging", "rebasing") — see RepoOpKind.
  if (request.opState) situation.push(`The repository is currently ${request.opState}.`)

  const error =
    Buffer.byteLength(request.error, 'utf8') > MAX_ERROR_BYTES
      ? `${Buffer.from(request.error, 'utf8').subarray(0, MAX_ERROR_BYTES).toString('utf8')}…`
      : request.error

  const parts: string[] = []
  if (situation.length > 0) parts.push(`Situation: ${situation.join(' ')}`)
  parts.push(`Git reported:\n${error}`)

  return [
    { role: 'system', content: rules.join('\n\n') },
    { role: 'user', content: parts.join('\n\n') }
  ]
}
