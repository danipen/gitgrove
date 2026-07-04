// Cloning: run the clone (remembering the parent folder for next time), report
// the default clone directory, probe a target path, and the folder picker.

import { dirname } from 'node:path'
import { IPC } from '@shared/ipc'
import { dialog, ipcMain } from 'electron'
import { getCloneBaseDir, rememberCloneBaseDir } from '../clone-prefs'
import { cloneTargetState, expandHome } from '../clone-target'
import * as gitSync from '../git/sync'
import type { HandlerDeps } from './context'

export function registerCloneHandlers(deps: HandlerDeps): void {
  const { windowFrom } = deps

  ipcMain.handle(IPC.cloneRepo, async (e, url: string, targetPath: string) => {
    const target = expandHome(targetPath)
    // Progress goes to the window whose clone dialog is running, not to
    // whichever window is focused — the user may be working elsewhere meanwhile.
    const dest = await gitSync.clone(url, target, (phase, percent) => {
      if (!e.sender.isDestroyed())
        e.sender.send(IPC.cloneProgress, { phase, percent, done: false })
    })
    // The next clone should land beside this one — remember the parent folder.
    rememberCloneBaseDir(dirname(target))
    return dest
  })
  ipcMain.handle(IPC.defaultCloneDir, () => getCloneBaseDir())
  ipcMain.handle(IPC.checkCloneTarget, (_e, targetPath: string) => cloneTargetState(targetPath))
  ipcMain.handle(IPC.pickDirectory, async (e, title?: string) => {
    const window = windowFrom(e.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: title ?? 'Choose Folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}
