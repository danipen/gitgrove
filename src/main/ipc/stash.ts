// Stash: list, the files a stash holds (tracked + the hidden untracked parent),
// save, apply/pop, and drop.

import { IPC } from '@shared/ipc'
import type { ChangedFile } from '@shared/types'
import { ipcMain } from 'electron'
import { getCommitFiles } from '../git/read'
import * as gitWrite from '../git/write'

export function registerStashHandlers(): void {
  ipcMain.handle(IPC.stashList, (_e, repoPath: string) => gitWrite.listStashes(repoPath))
  ipcMain.handle(IPC.stashFiles, async (_e, repoPath: string, sha: string) => {
    // A stash's tracked changes diff against its first parent; untracked
    // files live in a third parent commit (created by `stash push -u`) and
    // would otherwise be invisible in a review.
    const tracked = await getCommitFiles(repoPath, sha)
    let untracked: ChangedFile[] = []
    try {
      untracked = (await getCommitFiles(repoPath, `${sha}^3`)).map((f) => ({
        ...f,
        status: 'untracked' as const
      }))
    } catch {
      /* no untracked parent */
    }
    return [...tracked, ...untracked].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    )
  })
  ipcMain.handle(
    IPC.stashSave,
    (_e, repoPath: string, opts?: { message?: string; includeUntracked?: boolean }) =>
      gitWrite.stashSave(repoPath, opts)
  )
  ipcMain.handle(IPC.stashApply, (_e, repoPath: string, index: number, pop: boolean) =>
    gitWrite.stashApply(repoPath, index, pop)
  )
  ipcMain.handle(IPC.stashDrop, (_e, repoPath: string, index: number) =>
    gitWrite.stashDrop(repoPath, index)
  )
}
