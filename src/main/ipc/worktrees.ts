// Worktrees and submodules: list/add/remove worktrees, list/update submodules.

import { IPC } from '@shared/ipc'
import { ipcMain } from 'electron'
import * as gitWrite from '../git/write'

export function registerWorktreeHandlers(): void {
  ipcMain.handle(IPC.worktreeList, (_e, repoPath: string) => gitWrite.listWorktrees(repoPath))
  ipcMain.handle(
    IPC.worktreeAdd,
    (_e, repoPath: string, path: string, opts?: { branch?: string; newBranch?: string }) =>
      gitWrite.addWorktree(repoPath, path, opts)
  )
  ipcMain.handle(
    IPC.worktreeRemove,
    (_e, repoPath: string, path: string, opts?: { force?: boolean }) =>
      gitWrite.removeWorktree(repoPath, path, opts)
  )
  ipcMain.handle(IPC.submoduleList, (_e, repoPath: string) => gitWrite.listSubmodules(repoPath))
  ipcMain.handle(IPC.submoduleUpdate, (_e, repoPath: string) => gitWrite.updateSubmodules(repoPath))
}
