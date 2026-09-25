// The application menu, rebuilt whenever the open repo changes (its repo
// actions are disabled until one is open). On Windows/Linux the renderer's
// custom menu bar pops these same native submenus, so every action and role
// here works without being reimplemented in the UI.
//
// App actions come from the shared command registry (shared/commands.ts) — the
// same list the command palette searches — so the two surfaces can never
// disagree on a label or a shortcut. Clicking one just sends its id to the
// focused window's renderer, which runs it.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { type AppCommandId, appCommand, commandTitle } from '@shared/commands'
import { IPC } from '@shared/ipc'
import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from 'electron'
import { REPO_URL } from './app-info'

/**
 * What the menu needs from the app. GitGrove is multi-window: `getWindow` is
 * the *focused* window and `getRepoPath` the repo open in it — the menu is
 * rebuilt whenever focus moves or a window's repo changes, so its Repository
 * actions always target the window the user is looking at.
 */
export interface MenuContext {
  getWindow(): BrowserWindow | null
  getRepoPath(): string | null
  /** Open a fresh window (File ▸ New Window / the macOS dock menu). */
  newWindow(): void
  /** Run a manual update check; status is pushed to every window. */
  checkForUpdates(): void
}

export function buildMenu(ctx: MenuContext): void {
  const { getWindow, getRepoPath } = ctx
  const repoPath = getRepoPath()
  const sendCommand = (id: AppCommandId) => getWindow()?.webContents.send(IPC.menuCommand, id)

  /** A registry command as a menu item: its title, shortcut and repo gate. */
  const commandItem = (id: AppCommandId): MenuItemConstructorOptions => {
    const command = appCommand(id)
    return {
      label: commandTitle(id, process.platform),
      accelerator: command.accelerator,
      enabled: !command.needsRepo || !!repoPath,
      click: () => sendCommand(id)
    }
  }
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: commandTitle('check-updates', process.platform),
    // Runs in main: it must work even with no window to send a command to.
    click: () => ctx.checkForUpdates()
  }

  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              commandItem('about'),
              checkForUpdatesItem,
              { type: 'separator' as const },
              commandItem('settings'),
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          // Cmd/Ctrl+N, the platform convention (Finder, editors, browsers).
          // The new window opens on the welcome screen; "Open in New Window"
          // on a repo (repo switcher) is the one-gesture path to a second repo.
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => ctx.newWindow()
        },
        { type: 'separator' },
        commandItem('open-repo'),
        commandItem('clone'),
        { type: 'separator' },
        // macOS hosts this in the app menu (the conventional settings slot).
        ...(isMac ? [] : [commandItem('settings'), { type: 'separator' as const }]),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      // Mirrors the repo switcher's right-click actions for the repo currently
      // open in the renderer; disabled until one is.
      label: 'Repository',
      submenu: [
        commandItem('fetch'),
        commandItem('pull'),
        commandItem('push'),
        { type: 'separator' },
        commandItem('new-branch'),
        commandItem('stash'),
        { type: 'separator' },
        commandItem('undo'),
        { type: 'separator' },
        commandItem('optimize'),
        { type: 'separator' },
        commandItem('worktrees'),
        commandItem('submodules'),
        { type: 'separator' },
        commandItem('reveal-repo'),
        commandItem('open-terminal'),
        { type: 'separator' },
        commandItem('copy-repo-path'),
        commandItem('view-on-remote')
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        commandItem('search-everything'),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'GitGrove on GitHub',
          click: () => shell.openExternal(REPO_URL)
        },
        {
          label: 'Report an Issue…',
          click: () => shell.openExternal(`${REPO_URL}/issues/new`)
        },
        ...(isMac
          ? []
          : [{ type: 'separator' as const }, checkForUpdatesItem, commandItem('about')])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Open a terminal rooted at `cwd`. There's no cross-platform Electron API for
 * this, so launch the platform's stock terminal: Terminal.app on macOS, a new
 * `cmd` window on Windows, and the freedesktop-preferred emulator (falling back
 * through common ones) on Linux. Detaches the child so it outlives GitGrove and
 * returns whether a terminal was launched.
 */
export function openTerminal(cwd: string): boolean {
  const launch = (cmd: string, args: string[]): boolean => {
    try {
      const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return true
    } catch {
      return false
    }
  }

  if (process.platform === 'darwin') return launch('open', ['-a', 'Terminal', cwd])
  if (process.platform === 'win32')
    return launch('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `cd /d "${cwd}"`])
  // Linux: spawn reports a missing binary only asynchronously, so probe PATH
  // first and launch the user's configured emulator, then well-known ones.
  const onPath = (cmd: string) =>
    (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, cmd)))
  const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].find(onPath)
  return term ? launch(term, []) : false
}
