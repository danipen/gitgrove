import { describe, expect, test } from 'bun:test'
import type { AiCommitOptions } from '@shared/types'
import { buildCommitPrompt, type CommitPromptInput, capPatch } from './commit-prompt'

const options = (over: Partial<AiCommitOptions> = {}): AiCommitOptions => ({
  length: 'medium',
  tone: 'technical',
  emojis: false,
  ...over
})

const input = (over: Partial<CommitPromptInput> = {}): CommitPromptInput => ({
  mode: 'commit',
  options: options(),
  fileSummary: 'modified\tsrc/app.ts (+3 −1)',
  diffs: 'diff --git a/src/app.ts b/src/app.ts\n+added line\n-removed line\n',
  recentSubjects: ['feat: add graph tab', 'fix: stash panel overflow'],
  ...over
})

const system = (i: CommitPromptInput) => buildCommitPrompt(i)[0].content
const user = (i: CommitPromptInput) => buildCommitPrompt(i)[1].content

describe('buildCommitPrompt', () => {
  test('one system + one user message, diff and files in the user half', () => {
    const messages = buildCommitPrompt(input())
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
    expect(messages[1].content).toContain('modified\tsrc/app.ts')
    expect(messages[1].content).toContain('+added line')
  })

  test('the repo’s recent subjects ride along as the style guide', () => {
    expect(system(input())).toContain('feat: add graph tab')
    expect(system(input({ recentSubjects: [] }))).not.toContain('recent commit subjects')
  })

  test('length maps to distinct rules', () => {
    expect(system(input({ options: options({ length: 'short' }) }))).toContain('No body')
    expect(system(input({ options: options({ length: 'long' }) }))).toContain('thorough body')
  })

  test('every tone has copy', () => {
    for (const tone of ['technical', 'formal', 'informal', 'friendly'] as const) {
      expect(system(input({ options: options({ tone }) }))).toContain('Tone:')
    }
  })

  test('emojis are explicitly on or off — never unspecified', () => {
    expect(system(input({ options: options({ emojis: true }) }))).toContain('emoji at the start')
    expect(system(input())).toContain('Do not use emojis')
  })

  test('amend folds the previous message in', () => {
    const amend = input({ mode: 'amend', previousMessage: 'fix: old subject\n\nold body' })
    expect(user(amend)).toContain('fix: old subject')
    expect(user(amend)).toContain('amending')
    // A plain commit never mentions amending.
    expect(user(input())).not.toContain('amending')
  })

  test('stash asks for one short label instead of a commit message', () => {
    const stash = system(input({ mode: 'stash' }))
    expect(stash).toContain('stash')
    expect(stash).not.toContain('imperative mood')
  })
})

describe('capPatch', () => {
  test('short patches pass through untouched', () => {
    expect(capPatch('short\n', 1024)).toBe('short\n')
  })

  test('long patches are cut at a line boundary and marked', () => {
    const patch = `${'a'.repeat(50)}\n${'b'.repeat(50)}\n${'c'.repeat(50)}\n`
    const capped = capPatch(patch, 110)
    expect(capped.endsWith('[… diff truncated …]\n')).toBe(true)
    expect(capped).toContain('a'.repeat(50))
    expect(capped).not.toContain('c'.repeat(50))
    // Never cuts mid-line: every kept line is intact.
    const partial = capped.split('\n').some((l) => /^[abc]+$/.test(l) && l.length < 50)
    expect(partial).toBe(false)
  })

  test('multi-byte characters never come out mangled', () => {
    const patch = `${'é'.repeat(100)}\nnext\n`
    const capped = capPatch(patch, 51)
    expect(capped).not.toContain('�')
    expect(capped.endsWith('[… diff truncated …]\n')).toBe(true)
  })
})
