// The application menu, rebuilt whenever the open repo changes (its repo
// actions are disabled until one is open). On Windows/Linux the renderer's
// custom menu bar pops these same native submenus, so every action and role
// here works without being reimplemented in the UI.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { IPC, type MenuCommand } from '@shared/ipc'
import {
  app,
  type BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
  shell
} from 'electron'
import { REPO_URL } from './app-info'
import { getRemoteWebUrl } from './git/read'
import { checkForUpdates } from './updater'

/** What the menu needs from the app: the live window and the open repo path. */
export interface MenuContext {
  getWindow(): BrowserWindow | null
  getRepoPath(): string | null
}

export function buildMenu(ctx: MenuContext): void {
  const { getWindow, getRepoPath } = ctx
  const repoPath = getRepoPath()
  const send = (channel: string, ...args: unknown[]) =>
    getWindow()?.webContents.send(channel, ...args)
  const sendCommand = (command: MenuCommand) => send(IPC.menuCommand, command)

  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: `About ${app.name}`,
                click: () => send(IPC.menuShowAbout)
              },
              {
                label: 'Check for Updates…',
                click: () => checkForUpdates(getWindow, true)
              },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendCommand('settings')
              },
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
          label: 'Open Repository…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send(IPC.menuOpenRepo)
        },
        {
          label: 'Clone Repository…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendCommand('clone')
        },
        { type: 'separator' },
        // macOS hosts this in the app menu (the conventional settings slot).
        ...(isMac
          ? []
          : [
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendCommand('settings')
              } as MenuItemConstructorOptions,
              { type: 'separator' as const }
            ]),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      // Mirrors the repo switcher's right-click actions for the repo currently
      // open in the renderer; disabled until one is.
      label: 'Repository',
      submenu: [
        {
          label: 'Fetch',
          accelerator: 'CmdOrCtrl+Shift+F',
          enabled: !!repoPath,
          click: () => sendCommand('fetch')
        },
        {
          label: 'Pull',
          accelerator: 'CmdOrCtrl+Shift+P',
          enabled: !!repoPath,
          click: () => sendCommand('pull')
        },
        {
          label: 'Push',
          accelerator: 'CmdOrCtrl+P',
          enabled: !!repoPath,
          click: () => sendCommand('push')
        },
        { type: 'separator' },
        {
          label: 'New Branch…',
          accelerator: 'CmdOrCtrl+Shift+N',
          enabled: !!repoPath,
          click: () => sendCommand('new-branch')
        },
        {
          label: 'Stash All Changes…',
          enabled: !!repoPath,
          click: () => sendCommand('stash')
        },
        { type: 'separator' },
        // No accelerator: a global Cmd/Ctrl+Z here would hijack text undo in
        // the commit composer. The Changes banner is the primary affordance.
        {
          label: 'Undo Last Action',
          enabled: !!repoPath,
          click: () => sendCommand('undo')
        },
        { type: 'separator' },
        {
          label: 'Speed Up Large Repository',
          enabled: !!repoPath,
          click: () => sendCommand('optimize')
        },
        { type: 'separator' },
        {
          label: 'Worktrees…',
          enabled: !!repoPath,
          click: () => sendCommand('worktrees')
        },
        {
          label: 'Submodules…',
          enabled: !!repoPath,
          click: () => sendCommand('submodules')
        },
        { type: 'separator' },
        {
          label: isMac
            ? 'Reveal in Finder'
            : process.platform === 'win32'
              ? 'Show in Explorer'
              : 'Open Folder',
          enabled: !!repoPath,
          click: () => repoPath && shell.openPath(repoPath)
        },
        {
          label: 'Open in Terminal',
          enabled: !!repoPath,
          click: () => repoPath && openTerminal(repoPath)
        },
        { type: 'separator' },
        {
          label: 'Copy Repository Path',
          enabled: !!repoPath,
          click: () => repoPath && clipboard.writeText(repoPath)
        },
        {
          label: 'View on Remote',
          enabled: !!repoPath,
          click: async () => {
            if (!repoPath) return
            const url = await getRemoteWebUrl(repoPath)
            if (url) shell.openExternal(url)
          }
        }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
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
          : [
              { type: 'separator' as const },
              {
                label: 'Check for Updates…',
                click: () => checkForUpdates(getWindow, true)
              },
              {
                label: `About ${app.name}`,
                click: () => send(IPC.menuShowAbout)
              }
            ])
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
