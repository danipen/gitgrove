import { describe, expect, it } from 'bun:test'
import { APP_COMMANDS, appCommand, commandTitle, formatAccelerator } from './commands'

describe('APP_COMMANDS', () => {
  it('has unique ids', () => {
    const ids = APP_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never binds the same shortcut twice', () => {
    const accelerators = APP_COMMANDS.flatMap((c) => (c.accelerator ? [c.accelerator] : []))
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })
})

describe('commandTitle', () => {
  it('names the file manager per platform', () => {
    expect(commandTitle('reveal-repo', 'darwin')).toBe('Reveal in Finder')
    expect(commandTitle('reveal-repo', 'win32')).toBe('Show in Explorer')
    expect(commandTitle('reveal-repo', 'linux')).toBe('Open Folder')
  })

  it('uses the registry title otherwise', () => {
    expect(commandTitle('fetch', 'linux')).toBe(appCommand('fetch').title)
  })
})

describe('formatAccelerator', () => {
  it('uses glyphs in canonical order on macOS', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+F', 'darwin')).toBe('⇧⌘F')
    expect(formatAccelerator('CmdOrCtrl+K', 'darwin')).toBe('⌘K')
    expect(formatAccelerator('Shift+Alt+Ctrl+X', 'darwin')).toBe('⌃⌥⇧X')
  })

  it('spells modifiers out elsewhere', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+F', 'win32')).toBe('Ctrl+Shift+F')
    expect(formatAccelerator('CmdOrCtrl+,', 'linux')).toBe('Ctrl+,')
  })

  it('never repeats Ctrl when both spellings are present', () => {
    expect(formatAccelerator('CmdOrCtrl+Ctrl+A', 'win32')).toBe('Ctrl+A')
  })
})
