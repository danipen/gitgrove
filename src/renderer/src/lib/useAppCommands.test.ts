import { describe, expect, it } from 'bun:test'
import { appCommand } from '@shared/commands'
import { type CommandContext, isCommandAvailable, paletteCommands } from './useAppCommands'

const open: CommandContext = { hasRepo: true, hasRemotes: true, canUndo: true }

describe('isCommandAvailable', () => {
  it('hides repo commands until a repo is open', () => {
    const closed = { hasRepo: false, hasRemotes: false, canUndo: false }
    expect(isCommandAvailable(appCommand('fetch'), closed)).toBe(false)
    expect(isCommandAvailable(appCommand('clone'), closed)).toBe(true)
  })

  it('offers undo only when there is something to undo', () => {
    expect(isCommandAvailable(appCommand('undo'), open)).toBe(true)
    expect(isCommandAvailable(appCommand('undo'), { ...open, canUndo: false })).toBe(false)
  })

  it('offers View on Remote only with a remote', () => {
    expect(isCommandAvailable(appCommand('view-on-remote'), { ...open, hasRemotes: false })).toBe(
      false
    )
  })
})

describe('paletteCommands', () => {
  it('never lists the palette itself', () => {
    expect(paletteCommands(open).some((c) => c.id === 'search-everything')).toBe(false)
  })
})
