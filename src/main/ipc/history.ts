// History reads: the commit log and a commit's position in it, single-file
// history, blame, a commit's changed files, and the working/commit diffs.

import { IPC } from '@shared/ipc'
import type { ChangedFile, DiffArea, GraphLogOptions, LogOptions } from '@shared/types'
import { ipcMain } from 'electron'
import {
  getBlame,
  getCommitDiff,
  getCommitFiles,
  getCommitIndex,
  getFileHistory,
  getGraphLog,
  getLog,
  getMergeBase,
  getPatchIds,
  getRangeDiff,
  getRangeFiles,
  getWorkingDiff
} from '../git/read'

export function registerHistoryHandlers(): void {
  ipcMain.handle(IPC.log, (_e, repoPath: string, options?: LogOptions) => getLog(repoPath, options))
  ipcMain.handle(IPC.graphLog, (_e, repoPath: string, options?: GraphLogOptions) =>
    getGraphLog(repoPath, options)
  )
  ipcMain.handle(IPC.graphPatchIds, (_e, repoPath: string, hashes: string[]) =>
    getPatchIds(repoPath, hashes)
  )
  ipcMain.handle(IPC.commitIndex, (_e, repoPath: string, hash: string) =>
    getCommitIndex(repoPath, hash)
  )
  ipcMain.handle(IPC.fileHistory, (_e, repoPath: string, path: string, ref?: string) =>
    getFileHistory(repoPath, path, ref)
  )
  ipcMain.handle(IPC.blame, (_e, repoPath: string, path: string, ref?: string) =>
    getBlame(repoPath, path, ref)
  )
  ipcMain.handle(IPC.commitFiles, (_e, repoPath: string, hash: string) =>
    getCommitFiles(repoPath, hash)
  )
  ipcMain.handle(IPC.rangeFiles, (_e, repoPath: string, base: string | null, head: string) =>
    getRangeFiles(repoPath, base, head)
  )
  ipcMain.handle(IPC.mergeBase, (_e, repoPath: string, a: string, b: string) =>
    getMergeBase(repoPath, a, b)
  )
  ipcMain.handle(
    IPC.rangeDiff,
    (_e, repoPath: string, base: string | null, head: string, file: ChangedFile) =>
      getRangeDiff(repoPath, base, head, file)
  )
  ipcMain.handle(IPC.workingDiff, (_e, repoPath: string, file: ChangedFile, area?: DiffArea) =>
    getWorkingDiff(repoPath, file, area)
  )
  ipcMain.handle(IPC.commitDiff, (_e, repoPath: string, hash: string, file: ChangedFile) =>
    getCommitDiff(repoPath, hash, file)
  )
}
