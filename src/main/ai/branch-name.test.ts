import { describe, expect, test } from 'bun:test'
import {
  type BranchNamePromptInput,
  buildBranchNamePrompt,
  slugFromModelOutput
} from './branch-name'

describe('slugFromModelOutput', () => {
  test('a clean answer passes through', () => {
    expect(slugFromModelOutput('fix/stash-panel-empty-state')).toBe('fix/stash-panel-empty-state')
  })

  test('wrappers are stripped: fences, quotes, backticks, trailing period', () => {
    expect(slugFromModelOutput('```\nfeat/graph-zoom\n```')).toBe('feat/graph-zoom')
    expect(slugFromModelOutput('"fix/login-retry".')).toBe('fix/login-retry')
    expect(slugFromModelOutput('`chore/bump-deps`')).toBe('chore/bump-deps')
  })

  test('only the first non-empty line counts — explanations are discarded', () => {
    expect(slugFromModelOutput('\nfeat/dark-mode\nThis branch adds…')).toBe('feat/dark-mode')
  })

  test('prose collapses to kebab-case and illegal characters drop out', () => {
    expect(slugFromModelOutput('Fix Stash Panel!')).toBe('fix-stash-panel')
    expect(slugFromModelOutput('feat: add ~graph~ zoom')).toBe('feat-add-graph-zoom')
    expect(slugFromModelOutput('a__b   c')).toBe('a-b-c')
  })

  test('git ref rules hold per segment: no leading dots/dashes, no .lock, no empties', () => {
    expect(slugFromModelOutput('.hidden/-fix-')).toBe('hidden/fix')
    expect(slugFromModelOutput('fix//double')).toBe('fix/double')
    expect(slugFromModelOutput('fix/index.lock')).toBe('fix/index')
    expect(slugFromModelOutput('a..b')).toBe('a.b')
  })

  test('long names cut at a word boundary, never mid-word', () => {
    const long = `fix/${'stash-panel-'.repeat(10)}end`
    const slug = slugFromModelOutput(long)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toBe('fix/stash-panel-stash-panel-stash-panel-stash-panel-stash')
  })

  test('taken names get a numeric suffix, case-insensitively', () => {
    expect(slugFromModelOutput('fix/retry', ['fix/retry'])).toBe('fix/retry-2')
    expect(slugFromModelOutput('Fix/Retry', ['fix/retry', 'fix/retry-2'])).toBe('fix/retry-3')
    expect(slugFromModelOutput('fix/retry', ['other'])).toBe('fix/retry')
  })

  test('nothing usable yields empty — never an invalid prefill', () => {
    expect(slugFromModelOutput('')).toBe('')
    expect(slugFromModelOutput('!!! ???')).toBe('')
    expect(slugFromModelOutput('---')).toBe('')
  })
})

const input = (over: Partial<BranchNamePromptInput> = {}): BranchNamePromptInput => ({
  fileSummary: 'modified\tsrc/panel.ts (+3 −1)',
  diffs: 'diff --git a/src/panel.ts b/src/panel.ts\n+added\n',
  branchNames: ['feat/graph-tab', 'fix/stash-overflow'],
  currentBranch: 'main',
  ...over
})

describe('buildBranchNamePrompt', () => {
  test('one system + one user message; files and diffs in the user half', () => {
    const messages = buildBranchNamePrompt(input())
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].content).toContain('modified\tsrc/panel.ts')
    expect(messages[1].content).toContain('+added')
    expect(messages[1].content).toContain('"main"')
  })

  test('existing branch names ride along as the convention guide', () => {
    expect(buildBranchNamePrompt(input())[0].content).toContain('feat/graph-tab')
    expect(buildBranchNamePrompt(input({ branchNames: [] }))[0].content).not.toContain(
      'Existing branch names'
    )
  })

  test('no diffs → no empty Diffs block', () => {
    expect(buildBranchNamePrompt(input({ diffs: '' }))[1].content).not.toContain('Diffs:')
  })
})
