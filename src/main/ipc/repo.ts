// Opening, listing and inspecting repos: the open/recent/trust handlers, the
// host/PR lookups, reveal/terminal, the working-tree snapshot, the branch list,
// and branch checkout (which rides the write queue, so it reports progress).

import { IPC } from '@shared/ipc'
import type { BranchChangesAction, CheckoutResult } from '@shared/types'
import { dialog, ipcMain, shell } from 'electron'
import { getBranches, getRemoteWebUrl, getUnpushedCommits } from '../git/read'
import { getRepoSnapshot } from '../git/status'
import * as gitWrite from '../git/write'
import { getRepoHostInfo } from '../github/host'
import { listPullRequests } from '../github/pulls'
import { openTerminal } from '../menu'
import { getRecentRepos, removeRecentRepo } from '../store'
import type { HandlerDeps } from './context'

export function registerRepoHandlers(deps: HandlerDeps): void {
  const { getWindow, openRepoAtPath, takeInitialRepoPath, trustRepo, opProgressTo } = deps

  ipcMain.handle(IPC.pickRepo, async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Git Repository',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return openRepoAtPath(result.filePaths[0])
  })

  ipcMain.handle(IPC.openRepo, (_e, path: string) => openRepoAtPath(path))
  ipcMain.handle(IPC.initialRepoPath, () => takeInitialRepoPath())
  ipcMain.handle(IPC.trustRepo, (_e, path: string) => trustRepo(path))

  ipcMain.handle(IPC.recentRepos, () => getRecentRepos())
  ipcMain.handle(IPC.removeRecent, (_e, path: string) => removeRecentRepo(path))
  ipcMain.handle(IPC.remoteUrl, (_e, repoPath: string) => getRemoteWebUrl(repoPath))
  ipcMain.handle(IPC.repoHostInfo, (_e, repoPath: string) => getRepoHostInfo(repoPath))
  ipcMain.handle(IPC.pullRequests, (_e, repoPath: string) => listPullRequests(repoPath))
  ipcMain.handle(IPC.revealRepo, async (_e, repoPath: string) => {
    // openPath returns '' on success, an error string otherwise.
    const err = await shell.openPath(repoPath)
    return err === ''
  })
  ipcMain.handle(IPC.openTerminal, (_e, repoPath: string) => openTerminal(repoPath))

  // The snapshot is returned as a single JSON string: on a 90k-change repo the
  // object graph would otherwise be deep-copied twice (IPC structured clone,
  // then the contextBridge world boundary) — seconds of main-thread work.
  // Strings cross both boundaries in one cheap copy; the renderer parses.
  ipcMain.handle(IPC.snapshot, async (_e, repoPath: string) =>
    JSON.stringify(await getRepoSnapshot(repoPath))
  )
  ipcMain.handle(IPC.branches, (_e, repoPath: string) => getBranches(repoPath))
  ipcMain.handle(IPC.unpushedCommits, (_e, repoPath: string) => getUnpushedCommits(repoPath))
  ipcMain.handle(
    IPC.checkout,
    async (
      _e,
      repoPath: string,
      branch: string,
      opts?: { changes?: BranchChangesAction }
    ): Promise<CheckoutResult> => {
      // Checkout mutates HEAD/index/worktree → serialized on the write queue.
      const outcome = await gitWrite.checkoutBranch(
        repoPath,
        branch,
        opts,
        opProgressTo(repoPath, 'checkout')
      )
      return { branch: await getBranches(repoPath), outcome }
    }
  )
}
