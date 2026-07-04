// Network sync: fetch, pull, push — each reporting progress to the renderer.

import { IPC } from '@shared/ipc'
import { ipcMain } from 'electron'
import * as gitSync from '../git/sync'
import type { HandlerDeps } from './context'

export function registerSyncHandlers(deps: HandlerDeps): void {
  const { opProgressTo } = deps

  ipcMain.handle(IPC.fetch, (e, repoPath: string, remote?: string, opts?: { quiet?: boolean }) =>
    gitSync.fetch(repoPath, remote, opProgressTo(e.sender, repoPath, 'fetch'), opts)
  )
  ipcMain.handle(IPC.pull, (e, repoPath: string, opts?: { rebase?: boolean }) =>
    gitSync.pull(repoPath, opts, opProgressTo(e.sender, repoPath, 'pull'))
  )
  ipcMain.handle(
    IPC.push,
    (
      e,
      repoPath: string,
      opts?: { setUpstream?: { remote: string; branch: string }; forceWithLease?: boolean }
    ) => gitSync.push(repoPath, opts, opProgressTo(e.sender, repoPath, 'push'))
  )
}
