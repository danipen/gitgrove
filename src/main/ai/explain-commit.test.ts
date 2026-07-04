import { describe, expect, test } from 'bun:test'
import { buildExplainCommitPrompt, type ExplainCommitPromptInput } from './explain-commit'

const input = (over: Partial<ExplainCommitPromptInput> = {}): ExplainCommitPromptInput => ({
  shortHash: 'abc1234',
  subject: 'Fix stash panel overflow',
  body: 'The list clipped its last row on small windows.',
  authorName: 'Dani',
  date: '2026-07-01T10:00:00+02:00',
  fileSummary: 'modified\tsrc/panel.ts (+3 −1)',
  diffs: 'diff --git a/src/panel.ts b/src/panel.ts\n+added\n',
  ...over
})

describe('buildExplainCommitPrompt', () => {
  test('one system + one user message with hash, message, files and diffs', () => {
    const messages = buildExplainCommitPrompt(input())
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    const content = messages[1].content
    expect(content).toContain('abc1234')
    expect(content).toContain('Fix stash panel overflow\n\nThe list clipped its last row')
    expect(content).toContain('modified\tsrc/panel.ts')
    expect(content).toContain('+added')
  })

  test('a body-less commit sends just the subject as the message', () => {
    const content = buildExplainCommitPrompt(input({ body: '' }))[1].content
    expect(content).toContain('Message:\nFix stash panel overflow\n\nFiles:')
  })

  test('no diffs → no empty Diffs block', () => {
    expect(buildExplainCommitPrompt(input({ diffs: '' }))[1].content).not.toContain('Diffs:')
  })
})
