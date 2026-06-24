// Branch lifecycle: create, delete, rename, and detached checkout. (Switching
// to an existing branch lives with the repo handlers — it reports progress.)

import { IPC } from '@shared/ipc'
import type { BranchChangesAction } from '@shared/types'
import { ipcMain } from 'electron'
import * as gitWrite from '../git/write'

export function registerBranchHandlers(): void {
  ipcMain.handle(
    IPC.createBranch,
    (
      _e,
      repoPath: string,
      name: string,
      opts?: { from?: string; checkout?: boolean; changes?: BranchChangesAction }
    ) => gitWrite.createBranch(repoPath, name, opts)
  )
  ipcMain.handle(
    IPC.deleteBranch,
    (_e, repoPath: string, name: string, opts?: { force?: boolean }) =>
      gitWrite.deleteBranch(repoPath, name, opts)
  )
  ipcMain.handle(IPC.renameBranch, (_e, repoPath: string, from: string, to: string) =>
    gitWrite.renameBranch(repoPath, from, to)
  )
  ipcMain.handle(IPC.checkoutDetached, (_e, repoPath: string, hash: string) =>
    gitWrite.checkoutDetached(repoPath, hash)
  )
}
