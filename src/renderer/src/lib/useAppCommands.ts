// Runs the app's named commands (shared/commands.ts) — the one dispatcher
// behind both the native application menu and the command palette, so a
// command behaves identically whichever way the user reaches it.
//
// `runCommand` has a stable identity and always reads the latest state (via
// useEvent), so the menu subscription in useOsIntegration installs once.

import { APP_COMMANDS, type AppCommand, type AppCommandId } from '@shared/commands'
import type { RepoSummary, SyncStatus, UndoSnapshot } from '@shared/types'
import type { Modal } from '../components/app/AppModals'
import type { SyncAction } from '../components/toolbar/SyncButton'
import type { ThemePref } from './theme'
import { useEvent } from './useEvent'

export type AppTab = 'changes' | 'history' | 'graph'

interface Params {
  repo: RepoSummary | null
  sync: SyncStatus | null
  /** The one-step undo, when there is something to undo. */
  undo: UndoSnapshot | null
  /** True while a merge/rebase/… owns the working tree (no undo then). */
  opInFlight: boolean
  pickRepo: () => void
  doSync: (action: SyncAction) => void
  doUndo: () => void
  runOp: (fn: () => Promise<unknown>) => Promise<boolean>
  reloadBranches: () => void
  openModal: (modal: Modal) => void
  switchTab: (tab: AppTab) => void
  setThemePref: (pref: ThemePref) => void
  openAbout: () => void
  toggleSearch: () => void
  fail: (e: unknown) => void
}

/** What decides whether a command makes sense right now. */
export interface CommandContext {
  hasRepo: boolean
  hasRemotes: boolean
  /** An undo is recorded and no merge/rebase/… owns the working tree. */
  canUndo: boolean
}

export function isCommandAvailable(command: AppCommand, ctx: CommandContext): boolean {
  if (command.needsRepo && !ctx.hasRepo) return false
  if (command.id === 'undo') return ctx.canUndo
  if (command.id === 'view-on-remote') return ctx.hasRemotes
  return true
}

/** The commands the palette offers, in registry order — never itself. */
export function paletteCommands(ctx: CommandContext): AppCommand[] {
  return APP_COMMANDS.filter((c) => c.id !== 'search-everything' && isCommandAvailable(c, ctx))
}

export interface AppCommands {
  runCommand: (id: AppCommandId) => void
  /** paletteCommands for the current state. */
  availableCommands: () => AppCommand[]
}

export function useAppCommands(params: Params): AppCommands {
  const runCommand = useEvent((id: AppCommandId) => {
    const command = APP_COMMANDS.find((c) => c.id === id)
    // A menu click can race a repo close; the item was enabled a moment ago.
    if (!command || (command.needsRepo && !params.repo)) return
    const repoPath = params.repo?.path ?? ''
    const gg = window.gitgrove
    switch (id) {
      case 'search-everything':
        return params.toggleSearch()
      case 'open-repo':
        return params.pickRepo()
      case 'clone':
        return params.openModal({ kind: 'clone' })
      case 'settings':
        return params.openModal({ kind: 'settings' })
      case 'fetch':
      case 'pull':
      case 'push':
        return params.doSync(id)
      case 'new-branch':
        // Fresh enumeration for the dialog's default-branch option.
        params.reloadBranches()
        return params.openModal({ kind: 'new-branch' })
      case 'stash':
        return params.openModal({ kind: 'stash' })
      case 'undo':
        return params.doUndo()
      case 'optimize':
        params.runOp(() => gg.optimizeRepo(repoPath))
        return
      case 'worktrees':
        return params.openModal({ kind: 'worktrees' })
      case 'submodules':
        return params.openModal({ kind: 'submodules' })
      case 'reveal-repo':
        gg.revealRepo(repoPath).catch(params.fail)
        return
      case 'open-terminal':
        gg.openTerminal(repoPath).catch(params.fail)
        return
      case 'copy-repo-path':
        gg.clipboardWrite(repoPath).catch(params.fail)
        return
      case 'view-on-remote':
        gg.remoteUrl(repoPath)
          .then((url) => (url ? gg.openExternal(url) : undefined))
          .catch(params.fail)
        return
      case 'show-changes':
        return params.switchTab('changes')
      case 'show-history':
        return params.switchTab('history')
      case 'show-graph':
        return params.switchTab('graph')
      case 'theme-light':
        return params.setThemePref('light')
      case 'theme-dark':
        return params.setThemePref('dark')
      case 'theme-system':
        return params.setThemePref('system')
      case 'check-updates':
        gg.checkForUpdates(true).catch(params.fail)
        return
      case 'about':
        return params.openAbout()
    }
  })

  const availableCommands = useEvent(() =>
    paletteCommands({
      hasRepo: !!params.repo,
      hasRemotes: (params.sync?.remotes.length ?? 0) > 0,
      canUndo: !!params.undo && !params.opInFlight
    })
  )

  return { runCommand, availableCommands }
}
