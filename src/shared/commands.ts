// The app's command registry: every action a user can run by name — from the
// native application menu (main) and the command palette (renderer) alike.
// One list, so both surfaces show the same wording and the same shortcut, and
// a new action added here is instantly findable in the palette.
//
// A command is data only; *running* it is the renderer's job (see the
// renderer's useAppCommands), because every action lands in renderer state
// (a modal, a tab, a sync). The menu just sends the id over IPC.menuCommand.

export type AppCommandId =
  | 'search-everything'
  | 'open-repo'
  | 'clone'
  | 'settings'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'new-branch'
  | 'stash'
  | 'undo'
  | 'optimize'
  | 'worktrees'
  | 'submodules'
  | 'reveal-repo'
  | 'open-terminal'
  | 'copy-repo-path'
  | 'view-on-remote'
  | 'show-changes'
  | 'show-history'
  | 'show-graph'
  | 'theme-light'
  | 'theme-dark'
  | 'theme-system'
  | 'check-updates'
  | 'about'

export interface AppCommand {
  id: AppCommandId
  title: string
  /** Electron accelerator syntax (`CmdOrCtrl+Shift+F`) — registered by the
   *  menu, shown as a hint by the palette. */
  accelerator?: string
  /** Only meaningful with a repository open (disabled/hidden otherwise). */
  needsRepo: boolean
}

export const APP_COMMANDS: readonly AppCommand[] = [
  {
    id: 'search-everything',
    title: 'Search Everything…',
    accelerator: 'CmdOrCtrl+K',
    needsRepo: false
  },
  { id: 'open-repo', title: 'Open Repository…', accelerator: 'CmdOrCtrl+O', needsRepo: false },
  { id: 'clone', title: 'Clone Repository…', accelerator: 'CmdOrCtrl+Shift+O', needsRepo: false },
  { id: 'settings', title: 'Settings…', accelerator: 'CmdOrCtrl+,', needsRepo: false },
  { id: 'fetch', title: 'Fetch', accelerator: 'CmdOrCtrl+Shift+F', needsRepo: true },
  { id: 'pull', title: 'Pull', accelerator: 'CmdOrCtrl+Shift+P', needsRepo: true },
  { id: 'push', title: 'Push', accelerator: 'CmdOrCtrl+P', needsRepo: true },
  { id: 'new-branch', title: 'New Branch…', accelerator: 'CmdOrCtrl+Shift+N', needsRepo: true },
  { id: 'stash', title: 'Stash All Changes…', needsRepo: true },
  // No accelerator: a global Cmd/Ctrl+Z would hijack text undo in the commit
  // composer. The Changes banner is the primary affordance.
  { id: 'undo', title: 'Undo Last Action', needsRepo: true },
  { id: 'optimize', title: 'Speed Up Large Repository', needsRepo: true },
  { id: 'worktrees', title: 'Worktrees…', needsRepo: true },
  { id: 'submodules', title: 'Submodules…', needsRepo: true },
  { id: 'reveal-repo', title: 'Reveal Repository Folder', needsRepo: true },
  { id: 'open-terminal', title: 'Open in Terminal', needsRepo: true },
  { id: 'copy-repo-path', title: 'Copy Repository Path', needsRepo: true },
  { id: 'view-on-remote', title: 'View on Remote', needsRepo: true },
  { id: 'show-changes', title: 'Go to Changes', needsRepo: true },
  { id: 'show-history', title: 'Go to History', needsRepo: true },
  { id: 'show-graph', title: 'Go to Graph', needsRepo: true },
  { id: 'theme-light', title: 'Use Light Theme', needsRepo: false },
  { id: 'theme-dark', title: 'Use Dark Theme', needsRepo: false },
  { id: 'theme-system', title: 'Use System Theme', needsRepo: false },
  { id: 'check-updates', title: 'Check for Updates…', needsRepo: false },
  { id: 'about', title: 'About GitGrove', needsRepo: false }
]

const BY_ID = new Map(APP_COMMANDS.map((command) => [command.id, command]))

/** The command's display title, with the platform's name for the file manager. */
export function commandTitle(id: AppCommandId, platform: NodeJS.Platform): string {
  if (id === 'reveal-repo') {
    if (platform === 'darwin') return 'Reveal in Finder'
    if (platform === 'win32') return 'Show in Explorer'
    return 'Open Folder'
  }
  return appCommand(id).title
}

export function appCommand(id: AppCommandId): AppCommand {
  const command = BY_ID.get(id)
  if (!command) throw new Error(`Unknown command: ${id}`)
  return command
}

/** macOS modifier glyphs, in the platform's canonical ⌃⌥⇧⌘ order. */
const MAC_MODIFIERS: [string, string][] = [
  ['Ctrl', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['CmdOrCtrl', '⌘']
]

/**
 * An Electron accelerator as the platform writes shortcuts: `⇧⌘F` on macOS,
 * `Ctrl+Shift+F` elsewhere.
 */
export function formatAccelerator(accelerator: string, platform: NodeJS.Platform): string {
  const parts = accelerator.split('+')
  const key = parts[parts.length - 1]
  const modifiers = new Set(parts.slice(0, -1))
  if (platform === 'darwin') {
    const glyphs = MAC_MODIFIERS.filter(([name]) => modifiers.has(name)).map(([, glyph]) => glyph)
    return `${glyphs.join('')}${key}`
  }
  const names = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift']
    .filter((name) => modifiers.has(name))
    .map((name) => (name === 'CmdOrCtrl' ? 'Ctrl' : name))
  return [...new Set(names), key].join('+')
}
