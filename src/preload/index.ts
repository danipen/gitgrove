import { type GitGroveApi, IPC, type MenuCommand } from '@shared/ipc'
import type {
  ChangedFile,
  CloneProgress,
  CredentialPromptRequest,
  DeviceCodeInfo,
  DiffArea,
  GraphLogOptions,
  LogOptions,
  OpProgress,
  RemoteRepoPage,
  UpdateStatus
} from '@shared/types'
import { contextBridge, ipcRenderer } from 'electron'

const api: GitGroveApi = {
  platform: process.platform,
  pickRepo: () => ipcRenderer.invoke(IPC.pickRepo),
  openRepo: (path) => ipcRenderer.invoke(IPC.openRepo, path),
  openRepoInNewWindow: (path) => ipcRenderer.invoke(IPC.openRepoNewWindow, path),
  initialRepoPath: () => ipcRenderer.invoke(IPC.initialRepoPath),
  trustRepo: (path) => ipcRenderer.invoke(IPC.trustRepo, path),
  recentRepos: () => ipcRenderer.invoke(IPC.recentRepos),
  removeRecent: (path) => ipcRenderer.invoke(IPC.removeRecent, path),
  remoteUrl: (repoPath) => ipcRenderer.invoke(IPC.remoteUrl, repoPath),
  repoHostInfo: (repoPath) => ipcRenderer.invoke(IPC.repoHostInfo, repoPath),
  pullRequestsForBranches: (repoPath, branches) =>
    ipcRenderer.invoke(IPC.pullRequestsForBranches, repoPath, branches),
  revealRepo: (repoPath) => ipcRenderer.invoke(IPC.revealRepo, repoPath),
  openTerminal: (repoPath) => ipcRenderer.invoke(IPC.openTerminal, repoPath),
  snapshot: (repoPath) => ipcRenderer.invoke(IPC.snapshot, repoPath),
  branches: (repoPath) => ipcRenderer.invoke(IPC.branches, repoPath),
  unpushedCommits: (repoPath) => ipcRenderer.invoke(IPC.unpushedCommits, repoPath),
  checkout: (repoPath, branch, opts) => ipcRenderer.invoke(IPC.checkout, repoPath, branch, opts),
  log: (repoPath, options?: LogOptions) => ipcRenderer.invoke(IPC.log, repoPath, options),
  graphLog: (repoPath, options?: GraphLogOptions) =>
    ipcRenderer.invoke(IPC.graphLog, repoPath, options),
  graphPatchIds: (repoPath, hashes) => ipcRenderer.invoke(IPC.graphPatchIds, repoPath, hashes),
  commitIndex: (repoPath, hash) => ipcRenderer.invoke(IPC.commitIndex, repoPath, hash),
  fileHistory: (repoPath, path, ref) => ipcRenderer.invoke(IPC.fileHistory, repoPath, path, ref),
  blame: (repoPath, path, ref) => ipcRenderer.invoke(IPC.blame, repoPath, path, ref),
  commitFiles: (repoPath, hash) => ipcRenderer.invoke(IPC.commitFiles, repoPath, hash),
  rangeFiles: (repoPath, base, head) => ipcRenderer.invoke(IPC.rangeFiles, repoPath, base, head),
  workingDiff: (repoPath, file: ChangedFile, area?: DiffArea) =>
    ipcRenderer.invoke(IPC.workingDiff, repoPath, file, area),
  commitDiff: (repoPath, hash, file: ChangedFile) =>
    ipcRenderer.invoke(IPC.commitDiff, repoPath, hash, file),
  rangeDiff: (repoPath, base, head, file: ChangedFile) =>
    ipcRenderer.invoke(IPC.rangeDiff, repoPath, base, head, file),
  discardFiles: (repoPath, files, untrackedPaths) =>
    ipcRenderer.invoke(IPC.discardFiles, repoPath, files, untrackedPaths),
  ignorePatterns: (repoPath, patterns) =>
    ipcRenderer.invoke(IPC.ignorePatterns, repoPath, patterns),
  applyPatch: (repoPath, patch, opts) => ipcRenderer.invoke(IPC.applyPatch, repoPath, patch, opts),
  commit: (repoPath, message, selection) =>
    ipcRenderer.invoke(IPC.commit, repoPath, message, selection),
  lastCommitMessage: (repoPath) => ipcRenderer.invoke(IPC.lastCommitMessage, repoPath),
  fetch: (repoPath, remote, opts) => ipcRenderer.invoke(IPC.fetch, repoPath, remote, opts),
  pull: (repoPath, opts) => ipcRenderer.invoke(IPC.pull, repoPath, opts),
  push: (repoPath, opts) => ipcRenderer.invoke(IPC.push, repoPath, opts),
  getIdentity: (repoPath) => ipcRenderer.invoke(IPC.getIdentity, repoPath),
  setIdentity: (repoPath, name, email, scope) =>
    ipcRenderer.invoke(IPC.setIdentity, repoPath, name, email, scope),
  getGlobalIdentity: () => ipcRenderer.invoke(IPC.getGlobalIdentity),
  setGlobalIdentity: (name, email) => ipcRenderer.invoke(IPC.setGlobalIdentity, name, email),
  respondCredential: (requestId, value) =>
    ipcRenderer.invoke(IPC.credentialRespond, requestId, value),
  listAccounts: () => ipcRenderer.invoke(IPC.accountsList),
  beginAccountOAuth: (host, clientId) => ipcRenderer.invoke(IPC.accountsBeginOAuth, host, clientId),
  cancelAccountOAuth: () => ipcRenderer.invoke(IPC.accountsCancelOAuth),
  addAccountWithToken: (host, token) => ipcRenderer.invoke(IPC.accountsAddToken, host, token),
  removeAccount: (id) => ipcRenderer.invoke(IPC.accountsRemove, id),
  hasOAuthClient: (host) => ipcRenderer.invoke(IPC.accountsHasOAuthClient, host),
  lookupAvatarUrl: (email) => ipcRenderer.invoke(IPC.accountsLookupAvatar, email),
  listAccountRepos: (accountId) => ipcRenderer.invoke(IPC.accountRepos, accountId),
  createBranch: (repoPath, name, opts) =>
    ipcRenderer.invoke(IPC.createBranch, repoPath, name, opts),
  deleteBranch: (repoPath, name, opts) =>
    ipcRenderer.invoke(IPC.deleteBranch, repoPath, name, opts),
  renameBranch: (repoPath, from, to) => ipcRenderer.invoke(IPC.renameBranch, repoPath, from, to),
  checkoutDetached: (repoPath, hash) => ipcRenderer.invoke(IPC.checkoutDetached, repoPath, hash),
  merge: (repoPath, branch, opts) => ipcRenderer.invoke(IPC.merge, repoPath, branch, opts),
  mergePreview: (repoPath, branch) => ipcRenderer.invoke(IPC.mergePreview, repoPath, branch),
  commitMerge: (repoPath, message) => ipcRenderer.invoke(IPC.commitMerge, repoPath, message),
  mergeMessage: (repoPath) => ipcRenderer.invoke(IPC.mergeMessage, repoPath),
  rebase: (repoPath, onto) => ipcRenderer.invoke(IPC.rebase, repoPath, onto),
  rebaseInteractive: (repoPath, base, items) =>
    ipcRenderer.invoke(IPC.rebaseInteractive, repoPath, base, items),
  cherryPick: (repoPath, hash) => ipcRenderer.invoke(IPC.cherryPick, repoPath, hash),
  revertCommit: (repoPath, hash) => ipcRenderer.invoke(IPC.revertCommit, repoPath, hash),
  reset: (repoPath, hash, mode) => ipcRenderer.invoke(IPC.reset, repoPath, hash, mode),
  undo: (repoPath) => ipcRenderer.invoke(IPC.undo, repoPath),
  continueOp: (repoPath, op) => ipcRenderer.invoke(IPC.continueOp, repoPath, op),
  abortOp: (repoPath, op) => ipcRenderer.invoke(IPC.abortOp, repoPath, op),
  skipRebaseCommit: (repoPath) => ipcRenderer.invoke(IPC.skipRebaseCommit, repoPath),
  resolveConflict: (repoPath, path, side) =>
    ipcRenderer.invoke(IPC.resolveConflict, repoPath, path, side),
  markResolved: (repoPath, path) => ipcRenderer.invoke(IPC.markResolved, repoPath, path),
  conflictSides: (repoPath, path) => ipcRenderer.invoke(IPC.conflictSides, repoPath, path),
  openMergeTool: (repoPath, path) => ipcRenderer.invoke(IPC.openMergeTool, repoPath, path),
  mergeToolName: (repoPath) => ipcRenderer.invoke(IPC.mergeToolName, repoPath),
  openFileInEditor: (repoPath, path) => ipcRenderer.invoke(IPC.openFileInEditor, repoPath, path),
  stashList: (repoPath) => ipcRenderer.invoke(IPC.stashList, repoPath),
  stashFiles: (repoPath, sha) => ipcRenderer.invoke(IPC.stashFiles, repoPath, sha),
  stashSave: (repoPath, opts) => ipcRenderer.invoke(IPC.stashSave, repoPath, opts),
  stashApply: (repoPath, index, pop) => ipcRenderer.invoke(IPC.stashApply, repoPath, index, pop),
  stashDrop: (repoPath, index) => ipcRenderer.invoke(IPC.stashDrop, repoPath, index),
  createTag: (repoPath, name, opts) => ipcRenderer.invoke(IPC.createTag, repoPath, name, opts),
  deleteTag: (repoPath, name) => ipcRenderer.invoke(IPC.deleteTag, repoPath, name),
  worktreeList: (repoPath) => ipcRenderer.invoke(IPC.worktreeList, repoPath),
  worktreeAdd: (repoPath, path, opts) => ipcRenderer.invoke(IPC.worktreeAdd, repoPath, path, opts),
  worktreeRemove: (repoPath, path, opts) =>
    ipcRenderer.invoke(IPC.worktreeRemove, repoPath, path, opts),
  submoduleList: (repoPath) => ipcRenderer.invoke(IPC.submoduleList, repoPath),
  submoduleUpdate: (repoPath) => ipcRenderer.invoke(IPC.submoduleUpdate, repoPath),
  lfsHealth: (repoPath) => ipcRenderer.invoke(IPC.lfsHealth, repoPath),
  lfsEnable: (repoPath) => ipcRenderer.invoke(IPC.lfsEnable, repoPath),
  optimizeRepo: (repoPath) => ipcRenderer.invoke(IPC.optimizeRepo, repoPath),
  selectionSize: (repoPath, paths) => ipcRenderer.invoke(IPC.selectionSize, repoPath, paths),
  cloneRepo: (url, targetPath) => ipcRenderer.invoke(IPC.cloneRepo, url, targetPath),
  defaultCloneDir: () => ipcRenderer.invoke(IPC.defaultCloneDir),
  checkCloneTarget: (targetPath) => ipcRenderer.invoke(IPC.checkCloneTarget, targetPath),
  pickDirectory: (title) => ipcRenderer.invoke(IPC.pickDirectory, title),
  checkGit: (force) => ipcRenderer.invoke(IPC.checkGit, force),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  clipboardWrite: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  checkForUpdates: (manual) => ipcRenderer.invoke(IPC.checkForUpdates, manual),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  windowMinimize: () => ipcRenderer.invoke(IPC.windowMinimize),
  windowMaximizeToggle: () => ipcRenderer.invoke(IPC.windowMaximizeToggle),
  windowClose: () => ipcRenderer.invoke(IPC.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
  menuLabels: () => ipcRenderer.invoke(IPC.menuLabels),
  menuPopup: (label, x, y) => ipcRenderer.invoke(IPC.menuPopup, label, x, y),
  onWindowMaximized: (handler) => {
    const listener = (_e: unknown, maximized: boolean) => handler(maximized)
    ipcRenderer.on(IPC.windowMaximized, listener)
    return () => ipcRenderer.removeListener(IPC.windowMaximized, listener)
  },
  onRepoChanged: (handler) => {
    const listener = (_e: unknown, repoPath: string) => handler(repoPath)
    ipcRenderer.on(IPC.repoChanged, listener)
    return () => ipcRenderer.removeListener(IPC.repoChanged, listener)
  },
  onOpenRepoRequest: (handler) => {
    const listener = (_e: unknown, path: string) => handler(path)
    ipcRenderer.on(IPC.openRepoRequest, listener)
    return () => ipcRenderer.removeListener(IPC.openRepoRequest, listener)
  },
  onMenuOpenRepo: (handler) => {
    const listener = () => handler()
    ipcRenderer.on(IPC.menuOpenRepo, listener)
    return () => ipcRenderer.removeListener(IPC.menuOpenRepo, listener)
  },
  onShowAbout: (handler) => {
    const listener = () => handler()
    ipcRenderer.on(IPC.menuShowAbout, listener)
    return () => ipcRenderer.removeListener(IPC.menuShowAbout, listener)
  },
  onMenuCommand: (handler) => {
    const listener = (_e: unknown, command: MenuCommand) => handler(command)
    ipcRenderer.on(IPC.menuCommand, listener)
    return () => ipcRenderer.removeListener(IPC.menuCommand, listener)
  },
  onCloneProgress: (handler) => {
    const listener = (_e: unknown, progress: CloneProgress) => handler(progress)
    ipcRenderer.on(IPC.cloneProgress, listener)
    return () => ipcRenderer.removeListener(IPC.cloneProgress, listener)
  },
  onCredentialPrompt: (handler) => {
    const listener = (_e: unknown, request: CredentialPromptRequest) => handler(request)
    ipcRenderer.on(IPC.credentialPrompt, listener)
    return () => ipcRenderer.removeListener(IPC.credentialPrompt, listener)
  },
  onCredentialDismiss: (handler) => {
    const listener = (_e: unknown, requestId: string) => handler(requestId)
    ipcRenderer.on(IPC.credentialDismiss, listener)
    return () => ipcRenderer.removeListener(IPC.credentialDismiss, listener)
  },
  onAccountDeviceCode: (handler) => {
    const listener = (_e: unknown, info: DeviceCodeInfo) => handler(info)
    ipcRenderer.on(IPC.accountsDeviceCode, listener)
    return () => ipcRenderer.removeListener(IPC.accountsDeviceCode, listener)
  },
  onAccountsChanged: (handler) => {
    const listener = () => handler()
    ipcRenderer.on(IPC.accountsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.accountsChanged, listener)
  },
  onAccountReposPage: (handler) => {
    const listener = (_e: unknown, page: RemoteRepoPage) => handler(page)
    ipcRenderer.on(IPC.accountReposPage, listener)
    return () => ipcRenderer.removeListener(IPC.accountReposPage, listener)
  },
  onOpProgress: (handler) => {
    const listener = (_e: unknown, progress: OpProgress) => handler(progress)
    ipcRenderer.on(IPC.opProgress, listener)
    return () => ipcRenderer.removeListener(IPC.opProgress, listener)
  },
  onUpdateStatus: (handler) => {
    const listener = (_e: unknown, status: UpdateStatus) => handler(status)
    ipcRenderer.on(IPC.updateStatus, listener)
    return () => ipcRenderer.removeListener(IPC.updateStatus, listener)
  }
}

contextBridge.exposeInMainWorld('gitgrove', api)
