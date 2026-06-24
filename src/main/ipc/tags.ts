// Tags: create (optionally annotated and pushed) and delete.

import { IPC } from '@shared/ipc'
import { ipcMain } from 'electron'
import * as gitWrite from '../git/write'

export function registerTagHandlers(): void {
  ipcMain.handle(
    IPC.createTag,
    (
      _e,
      repoPath: string,
      name: string,
      opts?: { hash?: string; message?: string; push?: boolean }
    ) => gitWrite.createTag(repoPath, name, opts)
  )
  ipcMain.handle(IPC.deleteTag, (_e, repoPath: string, name: string) =>
    gitWrite.deleteTag(repoPath, name)
  )
}
