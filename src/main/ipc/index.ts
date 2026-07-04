// Registers every ipcMain handler — the main-process side of the IPC contract
// (`src/shared/ipc.ts`). Handlers are thin: argument plumbing into the git
// modules plus the few Electron-native services (dialogs, shell, clipboard,
// window controls). Anything with real logic lives in the modules it calls.
//
// The handlers are split by domain into the sibling modules below; this file is
// the thin orchestrator: it derives the progress forwarder from the app shell
// and hands the combined deps to each register*Handlers function.

import { IPC } from '@shared/ipc'
import type { OpProgress } from '@shared/types'
import { registerAccountHandlers } from './accounts'
import { registerAiHandlers } from './ai'
import { registerAppHandlers } from './app'
import { registerBranchHandlers } from './branches'
import { registerCloneHandlers } from './clone'
import type { HandlerDeps, IpcContext, OpProgressFactory } from './context'
import { registerHistoryHandlers } from './history'
import { registerIntegrationHandlers } from './integrate'
import { registerMaintenanceHandlers } from './maintenance'
import { registerRepoHandlers } from './repo'
import { registerStagingHandlers } from './staging'
import { registerStashHandlers } from './stash'
import { registerSyncHandlers } from './sync'
import { registerTagHandlers } from './tags'
import { registerWorktreeHandlers } from './worktrees'

export type { IpcContext } from './context'

export function registerIpc(ctx: IpcContext): void {
  // Progress goes back to the renderer that started the op — not broadcast:
  // another window busy on the same repo must not see this op's fill.
  const opProgressTo: OpProgressFactory = (sender, repoPath, kind) => (phase, percent) => {
    if (sender.isDestroyed()) return
    const progress: OpProgress = { repoPath, kind, phase, percent }
    sender.send(IPC.opProgress, progress)
  }
  const deps: HandlerDeps = { ...ctx, opProgressTo }

  registerRepoHandlers(deps)
  registerHistoryHandlers()
  registerStagingHandlers(deps)
  registerSyncHandlers(deps)
  registerAccountHandlers(deps)
  registerAiHandlers(deps)
  registerBranchHandlers()
  registerIntegrationHandlers()
  registerStashHandlers()
  registerTagHandlers()
  registerWorktreeHandlers()
  registerMaintenanceHandlers()
  registerCloneHandlers(deps)
  registerAppHandlers(deps)
}
