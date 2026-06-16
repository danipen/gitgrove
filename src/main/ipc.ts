// Registers every ipcMain handler — the main-process side of the IPC contract
// (`src/shared/ipc.ts`). Handlers are thin: argument plumbing into the git
// modules plus the few Electron-native services (dialogs, shell, clipboard,
// window controls). Anything with real logic lives in the modules it calls.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeHost } from '@shared/git-hosts'
import { IPC } from '@shared/ipc'
import type {
  BranchChangesAction,
  ChangedFile,
  CheckoutResult,
  CommitSelection,
  CredentialPrompt,
  CredentialPromptRequest,
  DiffArea,
  DiscardItem,
  GitAvailability,
  IdentityScope,
  LogOptions,
  OpProgress,
  ProgressOpKind,
  RebaseTodoItem,
  RepoOpenResult,
  RepoOpKind,
  ResetMode
} from '@shared/types'
import { type BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { lookupAvatarUrl } from './accounts/avatar'
import { accountsStore } from './accounts/cipher'
import { connectViaOAuth, connectWithToken, oauthClientIdFor } from './accounts/connect'
import { answerFromAccounts } from './accounts/store'
import { appInfo } from './app-info'
import { setCredentialResponder } from './git/askpass'
import { rejectStoredCredential } from './git/credential-store'
import { getGlobalIdentity, getIdentity, setGlobalIdentity, setIdentity } from './git/identity'
import { enableLfs, getLfsHealth } from './git/lfs'
import {
  getBlame,
  getBranches,
  getCommitDiff,
  getCommitFiles,
  getCommitIndex,
  getConflictSides,
  getFileHistory,
  getLog,
  getMergePreview,
  getMergeToolName,
  getRemoteWebUrl,
  getWorkingDiff
} from './git/read'
import { rebaseInteractive } from './git/rebase'
import { getRepoSnapshot } from './git/status'
import * as gitSync from './git/sync'
import * as gitWrite from './git/write'
import { openTerminal } from './menu'
import { getRecentRepos, removeRecentRepo } from './store'
import { checkForUpdates, quitAndInstall } from './updater'

/** What the handlers need from the app shell. */
export interface IpcContext {
  getWindow(): BrowserWindow | null
  openRepoAtPath(path: string): Promise<RepoOpenResult>
  /** The repo requested on launch, returned once then forgotten (see cli.ts). */
  takeInitialRepoPath(): string | null
  trustRepo(path: string): Promise<RepoOpenResult>
  checkGit(force: boolean): Promise<GitAvailability>
}

export function registerIpc(ctx: IpcContext): void {
  const { getWindow, openRepoAtPath, takeInitialRepoPath, trustRepo, checkGit } = ctx

  /**
   * Progress forwarder for a long-running op: pushes phase + percent to the
   * renderer so the matching button can fill determinately while git works.
   */
  const opProgressTo = (repoPath: string, kind: ProgressOpKind) => {
    return (phase: string, percent: number): void => {
      const progress: OpProgress = { repoPath, kind, phase, percent }
      getWindow()?.webContents.send(IPC.opProgress, progress)
    }
  }

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
  ipcMain.handle(IPC.log, (_e, repoPath: string, options?: LogOptions) => getLog(repoPath, options))
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
  ipcMain.handle(IPC.workingDiff, (_e, repoPath: string, file: ChangedFile, area?: DiffArea) =>
    getWorkingDiff(repoPath, file, area)
  )
  ipcMain.handle(IPC.commitDiff, (_e, repoPath: string, hash: string, file: ChangedFile) =>
    getCommitDiff(repoPath, hash, file)
  )

  // ── Staging & commits ──
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

  // ── Sync ──
  ipcMain.handle(IPC.fetch, (_e, repoPath: string, remote?: string, opts?: { quiet?: boolean }) =>
    gitSync.fetch(repoPath, remote, opProgressTo(repoPath, 'fetch'), opts)
  )
  ipcMain.handle(IPC.pull, (_e, repoPath: string, opts?: { rebase?: boolean }) =>
    gitSync.pull(repoPath, opts, opProgressTo(repoPath, 'pull'))
  )
  ipcMain.handle(
    IPC.push,
    (
      _e,
      repoPath: string,
      opts?: { setUpstream?: { remote: string; branch: string }; forceWithLease?: boolean }
    ) => gitSync.push(repoPath, opts, opProgressTo(repoPath, 'push'))
  )

  // ── Commit identity & credentials ──
  ipcMain.handle(IPC.getIdentity, (_e, repoPath: string) => getIdentity(repoPath))
  ipcMain.handle(
    IPC.setIdentity,
    (_e, repoPath: string, name: string, email: string, scope: IdentityScope) =>
      setIdentity(repoPath, name, email, scope)
  )
  ipcMain.handle(IPC.getGlobalIdentity, () => getGlobalIdentity())
  ipcMain.handle(IPC.setGlobalIdentity, (_e, name: string, email: string) =>
    setGlobalIdentity(name, email)
  )

  // Askpass bridge: when a network op hits a credential prompt, the askpass
  // server (git/askpass.ts) calls this responder. A connected account for the
  // prompt's host answers silently (login for the username, token for the
  // password); only strangers reach the renderer's CredentialDialog.
  // Secrets pass through these resolvers in memory only — never logged,
  // never persisted, and the map entry is dropped the moment it settles.
  let credentialSeq = 0
  const pendingCredentials = new Map<
    string,
    { prompt: CredentialPrompt; settle: (value: string | null) => void }
  >()
  setCredentialResponder((prompt, signal) => {
    const silent = answerFromAccounts(accountsStore(), prompt)
    if (silent !== null) return Promise.resolve(silent)
    const window = getWindow()
    // No window to ask — cancel so the operation fails fast instead of hanging.
    if (!window) return Promise.resolve(null)
    const requestId = `credential-${++credentialSeq}`
    return new Promise<string | null>((resolve) => {
      const settle = (value: string | null) => {
        if (pendingCredentials.delete(requestId)) resolve(value)
      }
      pendingCredentials.set(requestId, { prompt, settle })
      // The server aborts unanswered prompts (10 min): cancel and close the
      // renderer's dialog too, so it can't answer into the void after the
      // git operation has already failed.
      signal.addEventListener('abort', () => {
        settle(null)
        getWindow()?.webContents.send(IPC.credentialDismiss, requestId)
      })
      const request: CredentialPromptRequest = { requestId, ...prompt }
      window.webContents.send(IPC.credentialPrompt, request)
    })
  })
  ipcMain.handle(IPC.credentialRespond, (_e, requestId: string, value: string | null) => {
    pendingCredentials.get(requestId)?.settle(value)
  })

  // ── Connected accounts ──
  /**
   * A sign-in completed while git was already waiting on a prompt for that
   * host (the in-dialog "Sign in with GitHub" path): answer the waiting
   * prompt from the new account and close its dialog — the user finished in
   * the browser; asking them to also paste something would be absurd.
   */
  const answerPendingPromptsFor = (host: string) => {
    const wanted = normalizeHost(host)
    for (const [requestId, pending] of pendingCredentials) {
      if (!pending.prompt.host || normalizeHost(pending.prompt.host) !== wanted) continue
      const answer = answerFromAccounts(accountsStore(), pending.prompt)
      if (answer !== null) {
        pending.settle(answer)
        getWindow()?.webContents.send(IPC.credentialDismiss, requestId)
      }
    }
  }

  /**
   * After any successful connect: purge stale credential-helper copies (they
   * answer before askpass and would shadow the fresh token until a 401),
   * settle any waiting prompt, and tell the renderer to refetch the list.
   */
  const afterConnect = async (host: string) => {
    await rejectStoredCredential(host)
    answerPendingPromptsFor(host)
    getWindow()?.webContents.send(IPC.accountsChanged)
  }

  ipcMain.handle(IPC.accountsList, () => accountsStore().listAccounts())
  ipcMain.handle(
    IPC.accountsHasOAuthClient,
    (_e, host: string) => oauthClientIdFor(accountsStore(), host) !== null
  )
  ipcMain.handle(IPC.accountsLookupAvatar, (_e, email: string) =>
    lookupAvatarUrl(accountsStore(), email)
  )

  // One sign-in at a time: a newly started flow supersedes (aborts) the old.
  let oauthInFlight: AbortController | null = null
  ipcMain.handle(IPC.accountsBeginOAuth, async (_e, host: string, clientId?: string) => {
    oauthInFlight?.abort()
    const controller = new AbortController()
    oauthInFlight = controller
    const result = await connectViaOAuth(accountsStore(), host, {
      clientId,
      signal: controller.signal,
      onDeviceCode: (info) => getWindow()?.webContents.send(IPC.accountsDeviceCode, info)
    })
    if (oauthInFlight === controller) oauthInFlight = null
    if (result.ok) await afterConnect(result.account.host)
    return result
  })
  ipcMain.handle(IPC.accountsCancelOAuth, () => {
    oauthInFlight?.abort()
    oauthInFlight = null
  })
  ipcMain.handle(IPC.accountsAddToken, async (_e, host: string, token: string) => {
    const result = await connectWithToken(accountsStore(), host, token)
    if (result.ok) await afterConnect(result.account.host)
    return result
  })
  ipcMain.handle(IPC.accountsRemove, async (_e, id: string) => {
    const removed = accountsStore().removeAccount(id)
    // The OS helper still holds the token git stored on the last success —
    // sign-out must actually sign the machine out, not just forget metadata.
    if (removed) await rejectStoredCredential(removed.host)
    getWindow()?.webContents.send(IPC.accountsChanged)
  })

  // ── Branches ──
  ipcMain.handle(
    IPC.createBranch,
    (
      _e,
      repoPath: string,
      name: string,
      opts?: { from?: string; checkout?: boolean; changes?: BranchChangesAction }
    ) => gitWrite.createBranch(repoPath, name, opts)
  )
  ipcMain.handle(
    IPC.deleteBranch,
    (_e, repoPath: string, name: string, opts?: { force?: boolean }) =>
      gitWrite.deleteBranch(repoPath, name, opts)
  )
  ipcMain.handle(IPC.renameBranch, (_e, repoPath: string, from: string, to: string) =>
    gitWrite.renameBranch(repoPath, from, to)
  )
  ipcMain.handle(IPC.checkoutDetached, (_e, repoPath: string, hash: string) =>
    gitWrite.checkoutDetached(repoPath, hash)
  )

  // ── Merge / rebase / history surgery ──
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

  // ── Stash ──
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

  // ── Tags ──
  ipcMain.handle(
    IPC.createTag,
    (
      _e,
      repoPath: string,
      name: string,
      opts?: { hash?: string; message?: string; push?: boolean }
    ) => gitWrite.createTag(repoPath, name, opts)
  )
  ipcMain.handle(IPC.deleteTag, (_e, repoPath: string, name: string) =>
    gitWrite.deleteTag(repoPath, name)
  )

  // ── Worktrees & submodules ──
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
  ipcMain.handle(IPC.lfsHealth, (_e, repoPath: string) => getLfsHealth(repoPath))
  ipcMain.handle(IPC.lfsEnable, (_e, repoPath: string) => enableLfs(repoPath))
  ipcMain.handle(IPC.optimizeRepo, (_e, repoPath: string) => gitWrite.optimizeRepo(repoPath))
  ipcMain.handle(IPC.selectionSize, async (_e, repoPath: string, paths: string[]) => {
    // Working-tree byte sizes of the included files — a fast, honest proxy
    // for "how big is this commit" (these are the blobs about to be written).
    const sizes = await Promise.all(
      paths.map((p) =>
        stat(join(repoPath, p)).then(
          (s) => (s.isFile() ? s.size : 0),
          () => 0
        )
      )
    )
    return sizes.reduce((a, b) => a + b, 0)
  })

  // ── Clone ──
  ipcMain.handle(IPC.cloneRepo, (_e, url: string, parentDir: string) =>
    gitSync.clone(url, parentDir, (phase, percent) => {
      getWindow()?.webContents.send(IPC.cloneProgress, { phase, percent, done: false })
    })
  )
  ipcMain.handle(IPC.pickDirectory, async (_e, title?: string) => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: title ?? 'Choose Folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.checkGit, (_e, force?: boolean) => checkGit(!!force))
  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url))
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string) => clipboard.writeText(text))

  // Window controls for the custom title bar (Windows/Linux; no-ops elsewhere).
  ipcMain.handle(IPC.windowMinimize, () => getWindow()?.minimize())
  ipcMain.handle(IPC.windowMaximizeToggle, () => {
    const window = getWindow()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.handle(IPC.windowClose, () => getWindow()?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => getWindow()?.isMaximized() ?? false)

  // Custom always-visible menu bar (Windows/Linux): the renderer draws the
  // top-level labels and asks us to pop the corresponding native submenu, so all
  // the existing menu actions/roles work without being reimplemented in the UI.
  ipcMain.handle(IPC.menuLabels, () => {
    const menu = Menu.getApplicationMenu()
    return menu ? menu.items.filter((i) => i.submenu).map((i) => i.label) : []
  })
  ipcMain.handle(IPC.menuPopup, (_e, label: string, x: number, y: number) => {
    const item = Menu.getApplicationMenu()?.items.find((i) => i.label === label)
    const window = getWindow()
    if (item?.submenu && window) {
      item.submenu.popup({ window, x: Math.round(x), y: Math.round(y) })
    }
  })

  ipcMain.handle(IPC.appInfo, () => appInfo())
  ipcMain.handle(IPC.checkForUpdates, (_e, manual: boolean) => checkForUpdates(getWindow, manual))
  ipcMain.handle(IPC.installUpdate, () => quitAndInstall())
}
