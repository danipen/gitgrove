import { describe, expect, test } from 'bun:test'
import type { AiExplainErrorRequest } from '@shared/types'
import { buildExplainErrorPrompt } from './explain-error'

const request = (over: Partial<AiExplainErrorRequest> = {}): AiExplainErrorRequest => ({
  requestId: 'r1',
  error: 'error: failed to push some refs',
  ...over
})

describe('buildExplainErrorPrompt', () => {
  test('one system + one user message, the error verbatim in the user half', () => {
    const messages = buildExplainErrorPrompt(request())
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].content).toContain('error: failed to push some refs')
  })

  test('the repo situation rides along when known', () => {
    const content = buildExplainErrorPrompt(
      request({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, opState: 'merge' })
    )[1].content
    expect(content).toContain('On branch "main".')
    expect(content).toContain('origin/main (1 ahead, 2 behind)')
    expect(content).toContain('A merge is in progress.')
  })

  test('a branch without upstream says so — that IS the usual explanation', () => {
    expect(buildExplainErrorPrompt(request({ branch: 'b', upstream: null }))[1].content).toContain(
      'no upstream'
    )
  })

  test('no repo context → no empty Situation block', () => {
    expect(buildExplainErrorPrompt(request())[1].content).not.toContain('Situation:')
  })

  test('a runaway stderr dump is capped, marked with an ellipsis', () => {
    const content = buildExplainErrorPrompt(request({ error: 'x'.repeat(10_000) }))[1].content
    expect(content.length).toBeLessThan(6_000)
    expect(content).toContain('…')
  })
})
