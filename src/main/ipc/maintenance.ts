// Repo health & sizing: Git LFS status/enable, the large-repo optimization
// levers, and the byte size of a commit selection.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { ipcMain } from 'electron'
import { enableLfs, getLfsHealth } from '../git/lfs'
import * as gitWrite from '../git/write'

export function registerMaintenanceHandlers(): void {
  ipcMain.handle(IPC.lfsHealth, (_e, repoPath: string) => getLfsHealth(repoPath))
  ipcMain.handle(IPC.lfsEnable, (_e, repoPath: string) => enableLfs(repoPath))
  ipcMain.handle(IPC.optimizeRepo, (_e, repoPath: string) => gitWrite.optimizeRepo(repoPath))
  ipcMain.handle(IPC.selectionSize, async (_e, repoPath: string, paths: string[]) => {
    // Working-tree byte sizes of the included files — a fast, honest proxy
    // for "how big is this commit" (these are the blobs about to be written).
    const sizes = await Promise.all(
      paths.map((p) =>
        stat(join(repoPath, p)).then(
          (s) => (s.isFile() ? s.size : 0),
          () => 0
        )
      )
    )
    return sizes.reduce((a, b) => a + b, 0)
  })
}
