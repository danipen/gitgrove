// Branch-name suggestion: the create-branch dialog's ghost text. The prompt
// is assembled from the pending working-tree changes plus the repo's existing
// branch names (the naming convention — `fix/` vs `bugfix/`, ticket ids — is
// read, never configured). Everything the model answers is forced through
// slugFromModelOutput, so what reaches the dialog is always a ref-valid,
// collision-free slug — the renderer never has to distrust it.
//
// Prompt assembly and sanitizing are pure (unit-tested byte for byte);
// gatherBranchNameContext does the git reads, all on the lock-free read side.

import { getBranches, getWorkingDiff } from '../git/read'
import { getRepoSnapshot } from '../git/status'
import { summarizeFiles } from './commit-context'
import { capPatch } from './commit-prompt'
import type { ChatMessage } from './providers'

/** Everything the prompt needs, gathered by gatherBranchNameContext. */
export interface BranchNamePromptInput {
  /** One line per pending file: `status\tpath`. */
  fileSummary: string
  /** Concatenated (size-capped) working-tree diffs. */
  diffs: string
  /** Existing local branch names, most recently committed first. */
  branchNames: string[]
  currentBranch: string
}

/** Size caps — a name needs the gist of the change, not the whole change. */
export const BRANCH_NAME_CAPS = {
  perFileBytes: 8 * 1024,
  totalBytes: 32 * 1024,
  maxFiles: 20,
  /** Branch names shown as convention examples. */
  branchExamples: 25
} as const

/** Longest slug we ever suggest — names are for humans and `git branch` output. */
const MAX_SLUG_LENGTH = 60

/**
 * Force a model answer into a valid, available branch name. Handles every
 * wrapper models add despite instructions (fences, quotes, prose), squeezes
 * the rest into ref-safe kebab-case, and dodges `taken` names with a numeric
 * suffix. Returns '' when nothing usable survives — the dialog then simply
 * shows no ghost text, never an invalid prefill.
 */
export function slugFromModelOutput(text: string, taken: Iterable<string> = []): string {
  // First non-empty line, minus code fences and surrounding quote characters.
  let line =
    text
      .replace(/```[a-z]*/g, '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  line = line.replace(/^["'`]+/, '').replace(/["'`.]+$/, '')

  // Kebab-case, then keep only ref-safe characters ('/' allowed for prefixes).
  let slug = line
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9/._-]+/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/')

  // Git ref rules per path segment: no leading/trailing '.' or '-', and no
  // segment ending in '.lock'. Empty segments (from stripped junk) drop out.
  slug = slug
    .split('/')
    .map((s) =>
      s
        .replace(/(\.lock)+$/, '')
        .replace(/^[-.]+/, '')
        .replace(/[-.]+$/, '')
    )
    .filter(Boolean)
    .join('/')

  if (slug.length > MAX_SLUG_LENGTH) {
    const cut = slug.slice(0, MAX_SLUG_LENGTH)
    const boundary = Math.max(cut.lastIndexOf('-'), cut.lastIndexOf('/'))
    // Cut at a word boundary when one exists reasonably deep in; a mid-word
    // cut ("fix/stash-panel-emp") reads broken.
    slug = (boundary > 20 ? cut.slice(0, boundary) : cut).replace(/[-./]+$/, '')
  }
  if (!slug) return ''

  const takenSet = new Set(Array.from(taken, (t) => t.toLowerCase()))
  if (!takenSet.has(slug)) return slug
  for (let n = 2; n < 100; n++) {
    if (!takenSet.has(`${slug}-${n}`)) return `${slug}-${n}`
  }
  return ''
}

/** The system + user messages for one branch-name generation. */
export function buildBranchNamePrompt(input: BranchNamePromptInput): ChatMessage[] {
  const rules: string[] = [
    'You name git branches in a git client.',
    'Answer with ONLY the branch name: one short kebab-case slug that says what the change does, like fix/stash-panel-empty-state. No quotes, no explanation, no trailing period.',
    `At most 48 characters. Lowercase letters, digits and dashes; at most one "type/" prefix (fix/, feat/, chore/, …) — and only if the existing branches below use prefixes.`
  ]
  if (input.branchNames.length > 0) {
    rules.push(
      'Existing branch names in this repository — match their convention (prefix style, separators, ticket ids):',
      input.branchNames.map((b) => `  ${b}`).join('\n')
    )
  }

  const parts: string[] = [
    `Name a branch for these uncommitted changes (the user is currently on "${input.currentBranch}"):`,
    `Files:\n${input.fileSummary}`
  ]
  if (input.diffs) parts.push(`Diffs:\n${input.diffs}`)

  return [
    { role: 'system', content: rules.join('\n\n') },
    { role: 'user', content: parts.join('\n\n') }
  ]
}

/** What a suggestion needs from the repo: the pending changes + the naming style. */
export interface BranchNameContext {
  prompt: BranchNamePromptInput
  /** Every local branch name — the collision set for slugFromModelOutput. */
  takenNames: string[]
}

export async function gatherBranchNameContext(repoPath: string): Promise<BranchNameContext> {
  // Both reads are lock-free and independent — overlap them.
  const [snapshot, branches] = await Promise.all([getRepoSnapshot(repoPath), getBranches(repoPath)])

  const pieces: string[] = []
  let budget = BRANCH_NAME_CAPS.totalBytes
  const textFiles = snapshot.files.filter((f) => !f.binary && !f.submodule)
  for (const file of textFiles.slice(0, BRANCH_NAME_CAPS.maxFiles)) {
    if (budget <= 0) break
    try {
      const payload = await getWorkingDiff(repoPath, file, 'all')
      if (payload.binary || payload.lfs || payload.submodule || !payload.patch) continue
      const capped = capPatch(payload.patch, Math.min(BRANCH_NAME_CAPS.perFileBytes, budget))
      budget -= Buffer.byteLength(capped, 'utf8')
      pieces.push(capped)
    } catch {
      // A file that can't be diffed (racing deletion, permissions) contributes
      // no diff — its summary line still names it.
    }
  }

  return {
    prompt: {
      fileSummary: summarizeFiles(snapshot.files) || '(no pending changes)',
      diffs: pieces.join('\n'),
      branchNames: branches.local.slice(0, BRANCH_NAME_CAPS.branchExamples),
      currentBranch: snapshot.branch
    },
    takenNames: branches.local
  }
}
