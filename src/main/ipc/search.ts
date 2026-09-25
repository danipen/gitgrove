// Command-palette reads: every branch/tag, and the fuzzy file search over the
// repo's tracked files (ranked in main — see search/file-index.ts).

import { IPC } from '@shared/ipc'
import { ipcMain } from 'electron'
import { getRefs } from '../git/read'
import { searchFiles } from '../search/file-index'

export function registerSearchHandlers(): void {
  ipcMain.handle(IPC.refs, (_e, repoPath: string) => getRefs(repoPath))
  // Keyed by the calling window, so each window's newer query supersedes only
  // its own older one.
  ipcMain.handle(IPC.searchFiles, (e, repoPath: string, query: string, limit: number) =>
    searchFiles(repoPath, query, limit, String(e.sender.id))
  )
}
