import { describe, expect, test } from 'bun:test'
import { splitCommitMessage } from './ai'

describe('splitCommitMessage', () => {
  test('subject only', () => {
    expect(splitCommitMessage('Fix stash panel overflow')).toEqual({
      summary: 'Fix stash panel overflow',
      description: ''
    })
  })

  test('subject + body split on the first newline, blank line eaten', () => {
    expect(splitCommitMessage('Fix overflow\n\nThe panel grew unbounded.\nNow it clamps.')).toEqual(
      {
        summary: 'Fix overflow',
        description: 'The panel grew unbounded.\nNow it clamps.'
      }
    )
  })

  test('streams cleanly: a partial message is still well-formed', () => {
    expect(splitCommitMessage('Fix over')).toEqual({ summary: 'Fix over', description: '' })
    expect(splitCommitMessage('Fix overflow\nThe pa')).toEqual({
      summary: 'Fix overflow',
      description: 'The pa'
    })
  })

  test('strips the wrappers models sneak in despite instructions', () => {
    expect(splitCommitMessage('```\nFix overflow\n```')).toEqual({
      summary: 'Fix overflow',
      description: ''
    })
    expect(splitCommitMessage('"Fix overflow"')).toEqual({
      summary: 'Fix overflow',
      description: ''
    })
  })

  test('whitespace-only input yields empty fields', () => {
    expect(splitCommitMessage('  \n ')).toEqual({ summary: '', description: '' })
  })
})
