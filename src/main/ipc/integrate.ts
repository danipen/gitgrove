// Integrating histories and recovering from them: merge (+ preview/commit/
// message), rebase (incl. interactive), cherry-pick, revert, reset, undo, the
// continue/abort/skip controls, and conflict resolution (+ sides, merge tool).

import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { RebaseTodoItem, RepoOpKind, ResetMode } from '@shared/types'
import { ipcMain, shell } from 'electron'
import { getConflictSides, getMergePreview, getMergeToolName } from '../git/read'
import { rebaseInteractive } from '../git/rebase'
import { undo as undoLastOperation } from '../git/undo'
import * as gitWrite from '../git/write'

export function registerIntegrationHandlers(): void {
  ipcMain.handle(IPC.merge, (_e, repoPath: string, branch: string, opts?: { squash?: boolean }) =>
    gitWrite.merge(repoPath, branch, opts)
  )
  ipcMain.handle(IPC.mergePreview, (_e, repoPath: string, branch: string) =>
    getMergePreview(repoPath, branch)
  )
  ipcMain.handle(IPC.commitMerge, (_e, repoPath: string, message: string) =>
    gitWrite.commitMerge(repoPath, message)
  )
  ipcMain.handle(IPC.mergeMessage, (_e, repoPath: string) => gitWrite.mergeMessage(repoPath))
  ipcMain.handle(IPC.rebase, (_e, repoPath: string, onto: string) =>
    gitWrite.rebase(repoPath, onto)
  )
  ipcMain.handle(
    IPC.rebaseInteractive,
    (_e, repoPath: string, base: string, items: RebaseTodoItem[]) =>
      rebaseInteractive(repoPath, base, items)
  )
  ipcMain.handle(IPC.cherryPick, (_e, repoPath: string, hash: string) =>
    gitWrite.cherryPick(repoPath, hash)
  )
  ipcMain.handle(IPC.revertCommit, (_e, repoPath: string, hash: string) =>
    gitWrite.revertCommit(repoPath, hash)
  )
  ipcMain.handle(IPC.reset, (_e, repoPath: string, hash: string, mode: ResetMode) =>
    gitWrite.reset(repoPath, hash, mode)
  )
  ipcMain.handle(IPC.undo, (_e, repoPath: string) => undoLastOperation(repoPath))
  ipcMain.handle(IPC.continueOp, (_e, repoPath: string, op: RepoOpKind) =>
    gitWrite.continueOp(repoPath, op)
  )
  ipcMain.handle(IPC.abortOp, (_e, repoPath: string, op: RepoOpKind) =>
    gitWrite.abortOp(repoPath, op)
  )
  ipcMain.handle(IPC.skipRebaseCommit, (_e, repoPath: string) =>
    gitWrite.skipRebaseCommit(repoPath)
  )
  ipcMain.handle(
    IPC.resolveConflict,
    (_e, repoPath: string, path: string, side: 'ours' | 'theirs') =>
      gitWrite.resolveConflict(repoPath, path, side)
  )
  ipcMain.handle(IPC.markResolved, (_e, repoPath: string, path: string) =>
    gitWrite.markResolved(repoPath, path)
  )
  ipcMain.handle(IPC.conflictSides, (_e, repoPath: string, path: string) =>
    getConflictSides(repoPath, path)
  )
  ipcMain.handle(IPC.openMergeTool, (_e, repoPath: string, path: string) =>
    gitWrite.openMergeTool(repoPath, path)
  )
  ipcMain.handle(IPC.mergeToolName, (_e, repoPath: string) => getMergeToolName(repoPath))
  ipcMain.handle(IPC.openFileInEditor, (_e, repoPath: string, path: string) =>
    shell.openPath(join(repoPath, path)).then(() => undefined)
  )
}
