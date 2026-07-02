import { describe, expect, test } from 'bun:test'
import { reflowMessage } from './reflow'

describe('reflowMessage', () => {
  test('joins a paragraph hard-wrapped at the conventional column', () => {
    const body =
      'Playwright + CDP harness used to profile memory against a large\n' +
      'repo. Kept on this branch for reference; repo-path dependent, not\n' +
      'for main.'
    expect(reflowMessage(body)).toBe(
      'Playwright + CDP harness used to profile memory against a large ' +
        'repo. Kept on this branch for reference; repo-path dependent, not ' +
        'for main.'
    )
  })

  test('blank lines keep paragraphs apart', () => {
    const body = 'First paragraph wrapped at some fairly long column here\nand continued.\n\nSecond.'
    expect(reflowMessage(body)).toBe(
      'First paragraph wrapped at some fairly long column here and continued.\n\nSecond.'
    )
  })

  test('bullets, numbers and indented blocks stay formatted', () => {
    const body =
      '- profile-memory.mjs  full 6-scenario profiler that goes on and on\n' +
      '  continuation indented on purpose\n' +
      '1. first step of the list which is also quite long as lines go\n' +
      '2. second step'
    expect(reflowMessage(body)).toBe(body)
  })

  test('short deliberate lines never join', () => {
    const body = 'Reviewed-by: Ada\nSigned-off-by: Grace'
    expect(reflowMessage(body)).toBe(body)
  })
})
