// App-shell services: git availability, external links & clipboard, the custom
// title-bar window controls and menu bar (Windows/Linux), app info, and updates.

import { IPC } from '@shared/ipc'
import { clipboard, ipcMain, Menu, shell } from 'electron'
import { appInfo } from '../app-info'
import { checkForUpdates, quitAndInstall } from '../updater'
import type { HandlerDeps } from './context'

export function registerAppHandlers(deps: HandlerDeps): void {
  const { getWindow, checkGit } = deps

  ipcMain.handle(IPC.checkGit, (_e, force?: boolean) => checkGit(!!force))
  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url))
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string) => clipboard.writeText(text))

  // Window controls for the custom title bar (Windows/Linux; no-ops elsewhere).
  ipcMain.handle(IPC.windowMinimize, () => getWindow()?.minimize())
  ipcMain.handle(IPC.windowMaximizeToggle, () => {
    const window = getWindow()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.handle(IPC.windowClose, () => getWindow()?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => getWindow()?.isMaximized() ?? false)

  // Custom always-visible menu bar (Windows/Linux): the renderer draws the
  // top-level labels and asks us to pop the corresponding native submenu, so all
  // the existing menu actions/roles work without being reimplemented in the UI.
  ipcMain.handle(IPC.menuLabels, () => {
    const menu = Menu.getApplicationMenu()
    return menu ? menu.items.filter((i) => i.submenu).map((i) => i.label) : []
  })
  ipcMain.handle(IPC.menuPopup, (_e, label: string, x: number, y: number) => {
    const item = Menu.getApplicationMenu()?.items.find((i) => i.label === label)
    const window = getWindow()
    if (item?.submenu && window) {
      item.submenu.popup({ window, x: Math.round(x), y: Math.round(y) })
    }
  })

  ipcMain.handle(IPC.appInfo, () => appInfo())
  ipcMain.handle(IPC.checkForUpdates, (_e, manual: boolean) => checkForUpdates(getWindow, manual))
  ipcMain.handle(IPC.installUpdate, () => quitAndInstall())
}
