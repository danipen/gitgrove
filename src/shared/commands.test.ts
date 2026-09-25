import { describe, expect, it } from 'bun:test'
import { APP_COMMANDS, acceleratorKeys, appCommand, commandTitle } from './commands'

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

describe('acceleratorKeys', () => {
  it('uses glyphs in canonical order on macOS', () => {
    expect(acceleratorKeys('CmdOrCtrl+Shift+F', 'darwin')).toEqual(['⇧', '⌘', 'F'])
    expect(acceleratorKeys('CmdOrCtrl+K', 'darwin')).toEqual(['⌘', 'K'])
    expect(acceleratorKeys('Shift+Alt+Ctrl+X', 'darwin')).toEqual(['⌃', '⌥', '⇧', 'X'])
  })

  it('spells modifiers out elsewhere', () => {
    expect(acceleratorKeys('CmdOrCtrl+Shift+F', 'win32')).toEqual(['Ctrl', 'Shift', 'F'])
    expect(acceleratorKeys('CmdOrCtrl+,', 'linux')).toEqual(['Ctrl', ','])
  })

  it('never repeats Ctrl when both spellings are present', () => {
    expect(acceleratorKeys('CmdOrCtrl+Ctrl+A', 'win32')).toEqual(['Ctrl', 'A'])
  })
})
