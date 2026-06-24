// Staging & commits: discard (with trash + determinate progress), gitignore
// edits, hunk-level patch apply, the checkbox commit, and the amend prefill.

import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { CommitSelection, DiscardItem } from '@shared/types'
import { ipcMain, shell } from 'electron'
import * as gitWrite from '../git/write'
import type { HandlerDeps } from './context'

export function registerStagingHandlers(deps: HandlerDeps): void {
  const { opProgressTo } = deps

  ipcMain.handle(
    IPC.discardFiles,
    async (_e, repoPath: string, files: DiscardItem[], untrackedPaths: string[]) => {
      const { trashPaths, resetPaths, checkoutPaths } = gitWrite.planDiscard(files, untrackedPaths)
      // Big discards take real time (one trash call per file, then the git
      // steps) — report determinate progress so the dialog can show a bar.
      const progress = opProgressTo(repoPath, 'discard')
      let lastPercent = -1
      for (let i = 0; i < trashPaths.length; i++) {
        await shell.trashItem(join(repoPath, trashPaths[i])).catch(() => {})
        const percent = Math.round(((i + 1) / trashPaths.length) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          progress('Moving to trash', percent)
        }
      }
      await gitWrite.discardFiles(repoPath, resetPaths, checkoutPaths, progress)
    }
  )
  ipcMain.handle(IPC.ignorePatterns, (_e, repoPath: string, patterns: string[]) =>
    gitWrite.ignorePatterns(repoPath, patterns)
  )
  ipcMain.handle(
    IPC.applyPatch,
    (_e, repoPath: string, patch: string, opts: { cached?: boolean; reverse?: boolean }) =>
      gitWrite.applyPatch(repoPath, patch, opts)
  )
  ipcMain.handle(IPC.commit, (_e, repoPath: string, message: string, sel: CommitSelection) =>
    gitWrite.commitSelection(repoPath, message, sel)
  )
  ipcMain.handle(IPC.lastCommitMessage, (_e, repoPath: string) =>
    gitWrite.lastCommitMessage(repoPath)
  )
}
