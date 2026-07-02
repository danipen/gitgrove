// Central registry of IPC channel names and the typed shape of the API the
// preload script exposes on `window.gitgrove`. Both the main process handlers
// and the renderer client import from here so the contract stays in one place.

import type {
  AddAccountResult,
  AppInfo,
  AvatarLookupResult,
  BlameLine,
  BranchChangesAction,
  BranchInfo,
  ChangedFile,
  CheckoutOutcome,
  CheckoutResult,
  CloneProgress,
  CloneTargetState,
  Commit,
  CommitSelection,
  ConflictSides,
  ConnectedAccount,
  CredentialPromptRequest,
  DeviceCodeInfo,
  DiffArea,
  DiffPayload,
  DiscardItem,
  GitAvailability,
  GitIdentity,
  GlobalIdentity,
  GraphLogOptions,
  IdentityScope,
  LfsHealth,
  LogOptions,
  MergeOutcome,
  MergePreview,
  OpProgress,
  PullRequestLookup,
  RebaseTodoItem,
  RecentRepo,
  RemoteRepo,
  RemoteRepoPage,
  RepoHostInfo,
  RepoOpenResult,
  RepoOpKind,
  ResetMode,
  StashEntry,
  SubmoduleInfo,
  UndoResult,
  UpdateStatus,
  WorktreeInfo
} from './types'

export const IPC = {
  pickRepo: 'repo:pick',
  openRepo: 'repo:open',
  initialRepoPath: 'repo:initial-path',
  trustRepo: 'repo:trust',
  recentRepos: 'repo:recent',
  removeRecent: 'repo:recent:remove',
  remoteUrl: 'repo:remote-url',
  repoHostInfo: 'repo:host-info',
  pullRequestsForBranches: 'repo:pull-requests',
  revealRepo: 'repo:reveal',
  openTerminal: 'repo:terminal',
  snapshot: 'repo:snapshot',
  branches: 'repo:branches',
  unpushedCommits: 'repo:unpushed',
  checkout: 'repo:checkout',
  log: 'repo:log',
  graphLog: 'repo:graph:log',
  graphPatchIds: 'repo:graph:patch-ids',
  commitIndex: 'repo:commit:index',
  fileHistory: 'repo:file-history',
  blame: 'repo:blame',
  commitFiles: 'repo:commit:files',
  rangeFiles: 'repo:range:files',
  workingDiff: 'repo:diff:working',
  commitDiff: 'repo:diff:commit',
  rangeDiff: 'repo:diff:range',
  // staging & commits
  discardFiles: 'repo:discard',
  ignorePatterns: 'repo:ignore',
  applyPatch: 'repo:apply-patch',
  commit: 'repo:commit',
  lastCommitMessage: 'repo:last-commit-message',
  // sync
  fetch: 'repo:fetch',
  pull: 'repo:pull',
  push: 'repo:push',
  // commit identity (user.name / user.email)
  getIdentity: 'repo:identity:get',
  setIdentity: 'repo:identity:set',
  getGlobalIdentity: 'identity:global:get',
  setGlobalIdentity: 'identity:global:set',
  // credential prompting (askpass): renderer's answer to a credential:prompt
  credentialRespond: 'credential:respond',
  // connected accounts (browser OAuth / token sign-in to git hosts)
  accountsList: 'accounts:list',
  accountsBeginOAuth: 'accounts:oauth:begin',
  accountsCancelOAuth: 'accounts:oauth:cancel',
  accountsAddToken: 'accounts:add-token',
  accountsRemove: 'accounts:remove',
  accountsHasOAuthClient: 'accounts:has-oauth-client',
  accountsLookupAvatar: 'accounts:avatar-lookup',
  accountRepos: 'accounts:repos',
  // branches
  createBranch: 'repo:branch:create',
  deleteBranch: 'repo:branch:delete',
  renameBranch: 'repo:branch:rename',
  checkoutDetached: 'repo:checkout-detached',
  // merge / rebase / history surgery
  merge: 'repo:merge',
  mergePreview: 'repo:merge-preview',
  commitMerge: 'repo:merge-commit',
  mergeMessage: 'repo:merge-message',
  rebase: 'repo:rebase',
  rebaseInteractive: 'repo:rebase-interactive',
  cherryPick: 'repo:cherry-pick',
  revertCommit: 'repo:revert',
  reset: 'repo:reset',
  undo: 'repo:undo',
  continueOp: 'repo:op:continue',
  abortOp: 'repo:op:abort',
  skipRebaseCommit: 'repo:op:skip',
  resolveConflict: 'repo:conflict:resolve',
  markResolved: 'repo:conflict:mark-resolved',
  conflictSides: 'repo:conflict:sides',
  openMergeTool: 'repo:conflict:merge-tool',
  mergeToolName: 'repo:conflict:merge-tool-name',
  openFileInEditor: 'repo:open-file',
  // stash
  stashList: 'repo:stash:list',
  stashFiles: 'repo:stash:files',
  stashSave: 'repo:stash:save',
  stashApply: 'repo:stash:apply',
  stashDrop: 'repo:stash:drop',
  // tags
  createTag: 'repo:tag:create',
  deleteTag: 'repo:tag:delete',
  // worktrees & submodules
  worktreeList: 'repo:worktree:list',
  worktreeAdd: 'repo:worktree:add',
  worktreeRemove: 'repo:worktree:remove',
  submoduleList: 'repo:submodule:list',
  submoduleUpdate: 'repo:submodule:update',
  // git lfs
  lfsHealth: 'repo:lfs:health',
  lfsEnable: 'repo:lfs:enable',
  optimizeRepo: 'repo:optimize',
  selectionSize: 'repo:selection-size',
  // clone
  cloneRepo: 'repo:clone',
  defaultCloneDir: 'repo:clone:default-dir',
  checkCloneTarget: 'repo:clone:check-target',
  pickDirectory: 'app:pick-directory',
  // environment / app / updates
  checkGit: 'git:check',
  openExternal: 'app:open-external',
  clipboardWrite: 'app:clipboard-write',
  appInfo: 'app:info',
  checkForUpdates: 'update:check',
  installUpdate: 'update:install',
  // custom window controls (Windows/Linux title bar)
  windowMinimize: 'window:minimize',
  windowMaximizeToggle: 'window:maximize-toggle',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  // custom menu bar (Windows/Linux title bar)
  menuLabels: 'menu:labels',
  menuPopup: 'menu:popup',
  // main -> renderer pushes
  repoChanged: 'repo:changed',
  menuOpenRepo: 'menu:open-repo',
  menuShowAbout: 'menu:about',
  /** Generic application-menu command (payload: a MenuCommand string). */
  menuCommand: 'menu:command',
  cloneProgress: 'repo:clone-progress',
  /** A network op needs a credential — show the dialog (CredentialPromptRequest). */
  credentialPrompt: 'credential:prompt',
  /** A credential prompt expired unanswered — close its dialog (requestId). */
  credentialDismiss: 'credential:dismiss',
  /** A device-flow sign-in produced its user code (DeviceCodeInfo). */
  accountsDeviceCode: 'accounts:oauth:device-code',
  /** The connected-accounts list changed (added/removed) — refetch. */
  accountsChanged: 'accounts:changed',
  /** One page of a repo listing, pushed as it arrives (RemoteRepoPage). */
  accountReposPage: 'accounts:repos-page',
  /** Determinate progress of a running checkout/fetch/pull/push (OpProgress). */
  opProgress: 'repo:op-progress',
  updateStatus: 'update:status',
  windowMaximized: 'window:maximized'
} as const

/** Commands the application menu sends to the renderer to act on. */
export type MenuCommand =
  | 'settings'
  | 'clone'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'new-branch'
  | 'undo'
  | 'stash'
  | 'worktrees'
  | 'submodules'
  | 'optimize'

export interface GitGroveApi {
  /** Host platform, resolved synchronously at preload so the UI can branch on it. */
  platform: NodeJS.Platform
  /** Open the native folder picker; resolves null if cancelled, else the outcome. */
  pickRepo(): Promise<RepoOpenResult | null>
  /** Open a known path as a repository. */
  openRepo(path: string): Promise<RepoOpenResult>
  /**
   * The repository requested on launch (via `--repo` or GITGROVE_OPEN_REPO), or
   * null. Consumed once: a later reload returns null so it doesn't reopen.
   */
  initialRepoPath(): Promise<string | null>
  /** Trust a folder git flagged as untrusted (persist a safe.directory exception), then open it. */
  trustRepo(path: string): Promise<RepoOpenResult>
  recentRepos(): Promise<RecentRepo[]>
  removeRecent(path: string): Promise<RecentRepo[]>
  /** Resolve the repo's remote to a browsable web URL, or null if it has none. */
  remoteUrl(repoPath: string): Promise<string | null>
  /** The repo's web URL plus whether its host supports GitHub-aware actions. */
  repoHostInfo(repoPath: string): Promise<RepoHostInfo>
  /**
   * The PRs for each of `branches`, looked up by head ref on the repo's GitHub
   * remote, plus the per-branch totals (which can exceed the fetched count).
   * Returns empty (`{ prs: [], totals: {} }`) when not on GitHub or no account is
   * connected; the caller knows which branches it asked about, so a branch with
   * no PRs in the result is "checked, no PR".
   */
  pullRequestsForBranches(repoPath: string, branches: string[]): Promise<PullRequestLookup>
  /** Open the repo folder in the OS file manager (Finder/Explorer/…). */
  revealRepo(repoPath: string): Promise<boolean>
  /** Open a terminal rooted at the repo. Resolves false if none could launch. */
  openTerminal(repoPath: string): Promise<boolean>
  /**
   * One-call refresh payload: files, branch, sync counts, op state, stashes.
   * JSON-encoded (`RepoSnapshot`) so huge change lists cross the IPC and
   * contextBridge boundaries as one cheap string copy — parse on the caller's
   * side of the bridge, never in the preload world.
   */
  snapshot(repoPath: string): Promise<string>
  branches(repoPath: string): Promise<BranchInfo>
  /** Full SHAs of commits on a local branch but no remote ("not pushed yet"). */
  unpushedCommits(repoPath: string): Promise<string[]>
  /**
   * Switch to a branch. `changes` says what to do with uncommitted changes
   * (bring along / leave auto-stashed) — see git/write.ts checkoutBranch.
   * Resolves with the refreshed branch state and a 'conflicts' outcome when
   * brought-along changes need resolving (normal step, not an error).
   */
  checkout(
    repoPath: string,
    branch: string,
    opts?: { changes?: BranchChangesAction }
  ): Promise<CheckoutResult>
  log(repoPath: string, options?: LogOptions): Promise<Commit[]>
  /**
   * The Graph tab's feed: commits reachable from any branch, remote or tag
   * (plus HEAD), newest first in `--date-order` so every commit precedes its
   * parents — the order the diagram's layout depends on.
   */
  graphLog(repoPath: string, options?: GraphLogOptions): Promise<Commit[]>
  /**
   * Patch-id per commit (`git patch-id --stable`) for the given hashes: equal
   * ids mean the same change — how the Graph spots cherry-picked backports
   * (its twin markers). Merges, empty commits and unknown hashes drop out of
   * the result.
   */
  graphPatchIds(repoPath: string, hashes: string[]): Promise<Record<string, string>>
  /** How many commits sit between HEAD and `hash` (i.e. `hash`'s 0-based index
   *  in `git log HEAD`), so the History list can page far enough to reveal it.
   *  `-1` when `hash` isn't an ancestor of HEAD. */
  commitIndex(repoPath: string, hash: string): Promise<number>
  /** Commits that touched a single file, newest first (follows renames). */
  fileHistory(repoPath: string, path: string, ref?: string): Promise<Commit[]>
  /** Per-line authorship for a file; no `ref` blames the working tree. */
  blame(repoPath: string, path: string, ref?: string): Promise<BlameLine[]>
  commitFiles(repoPath: string, hash: string): Promise<ChangedFile[]>
  /**
   * Files changed across `base..head` — the Graph tab's branch-changes view
   * (everything a branch did since it split off). A null `base` means the
   * branch starts at a root commit; the diff runs against the empty tree.
   */
  rangeFiles(repoPath: string, base: string | null, head: string): Promise<ChangedFile[]>
  workingDiff(repoPath: string, file: ChangedFile, area?: DiffArea): Promise<DiffPayload>
  commitDiff(repoPath: string, hash: string, file: ChangedFile): Promise<DiffPayload>
  /** One file's diff across `base..head` — see rangeFiles. */
  rangeDiff(
    repoPath: string,
    base: string | null,
    head: string,
    file: ChangedFile
  ): Promise<DiffPayload>
  // ── Staging & commits ──
  /**
   * Discard changes so the chosen paths end up exactly as in HEAD: staged
   * state is reset, original files are restored, and files HEAD doesn't have
   * (untracked, staged-new, rename targets) move to the OS trash so a
   * mis-click is recoverable.
   */
  discardFiles(repoPath: string, files: DiscardItem[], untrackedPaths: string[]): Promise<void>
  /**
   * Append gitignore pattern lines to the repo root's `.gitignore` (created if
   * missing); lines already present are skipped. Patterns are built in the
   * renderer — see lib/ignore.ts.
   */
  ignorePatterns(repoPath: string, patterns: string[]): Promise<void>
  /** Apply a (hunk) patch to the index/working tree — see git/write.ts applyPatch. */
  applyPatch(
    repoPath: string,
    patch: string,
    opts: { cached?: boolean; reverse?: boolean }
  ): Promise<void>
  /** Commit the checkbox selection — see git/write.ts commitSelection. */
  commit(repoPath: string, message: string, selection: CommitSelection): Promise<void>
  lastCommitMessage(repoPath: string): Promise<string>
  // ── Sync ──
  /** Fetch from a remote. `quiet` (background timer) never prompts for credentials. */
  fetch(repoPath: string, remote?: string, opts?: { quiet?: boolean }): Promise<void>
  pull(repoPath: string, opts?: { rebase?: boolean }): Promise<void>
  push(
    repoPath: string,
    opts?: { setUpstream?: { remote: string; branch: string }; forceWithLease?: boolean }
  ): Promise<void>
  // ── Commit identity & credentials ──
  /** The commit identity (user.name/user.email) git would use in this repo. */
  getIdentity(repoPath: string): Promise<GitIdentity>
  /** Persist a commit identity to the global or this repo's git config. */
  setIdentity(repoPath: string, name: string, email: string, scope: IdentityScope): Promise<void>
  /** The machine-wide identity from the global git config (no repo needed). */
  getGlobalIdentity(): Promise<GlobalIdentity>
  /** Write the machine-wide identity to the global git config. */
  setGlobalIdentity(name: string, email: string): Promise<void>
  /**
   * Answer a credential prompt pushed via onCredentialPrompt. `null` cancels:
   * the askpass helper exits non-zero and the waiting git op aborts cleanly.
   * The value goes straight to the waiting git process — never stored.
   */
  respondCredential(requestId: string, value: string | null): Promise<void>
  // ── Connected accounts ──
  /** Connected git-host accounts (metadata only — tokens stay in main). */
  listAccounts(): Promise<ConnectedAccount[]>
  /**
   * Start a browser device-flow sign-in for `host`. The user code arrives via
   * onAccountDeviceCode; this resolves when the user finishes (or fails) in
   * the browser. `clientId` is required for Enterprise hosts the first time —
   * once a sign-in succeeds it is remembered for that host.
   */
  beginAccountOAuth(host: string, clientId?: string): Promise<AddAccountResult>
  /** Abort the in-flight device-flow sign-in, if any. */
  cancelAccountOAuth(): Promise<void>
  /** Connect an account from a pasted personal access token. */
  addAccountWithToken(host: string, token: string): Promise<AddAccountResult>
  /** Disconnect an account and purge its OS-credential-helper copies. */
  removeAccount(id: string): Promise<void>
  /**
   * Whether browser sign-in is possible for `host` (built-in client ID for
   * github.com, or one remembered from a previous Enterprise sign-in).
   */
  hasOAuthClient(host: string): Promise<boolean>
  /**
   * Resolve a commit email to the connected host's avatar URL (exact hits and
   * detectable misses — the avatar fallback chain's first stop). The search
   * runs in main because it needs the account token.
   */
  lookupAvatarUrl(email: string): Promise<AvatarLookupResult>
  /**
   * Repositories the connected account `accountId` can clone, most recently
   * pushed first. Runs in main because it needs the account's token; rejects
   * with a human message on auth/network failure so the picker can retry.
   * Pages also stream in via onAccountReposPage as they arrive — await this
   * for the final, complete (de-duplicated, sorted) list and the "done" signal.
   */
  listAccountRepos(accountId: string): Promise<RemoteRepo[]>
  // ── Branches ──
  /**
   * Create a branch, optionally from a base ref and optionally carrying or
   * leaving the working tree's uncommitted changes (`changes`, only
   * meaningful with checkout) — same choreography and outcome contract as
   * `checkout`, see git/write.ts.
   */
  createBranch(
    repoPath: string,
    name: string,
    opts?: { from?: string; checkout?: boolean; changes?: BranchChangesAction }
  ): Promise<CheckoutOutcome>
  deleteBranch(repoPath: string, name: string, opts?: { force?: boolean }): Promise<void>
  renameBranch(repoPath: string, from: string, to: string): Promise<void>
  checkoutDetached(repoPath: string, hash: string): Promise<void>
  // ── Merge / rebase / history surgery ──
  /**
   * Merge `branch` into the current branch. Conflicts come back as data
   * ('conflicts'), never as a rejection — they're a normal step, not an error.
   */
  merge(repoPath: string, branch: string, opts?: { squash?: boolean }): Promise<MergeOutcome>
  /** Dry-run prediction of merging `branch` — see git/read.ts getMergePreview. */
  mergePreview(repoPath: string, branch: string): Promise<MergePreview>
  /** Conclude an in-progress merge as a regular commit with `message`. */
  commitMerge(repoPath: string, message: string): Promise<void>
  /** Git's prepared merge message (MERGE_MSG, comments stripped); '' when not merging. */
  mergeMessage(repoPath: string): Promise<string>
  rebase(repoPath: string, onto: string): Promise<MergeOutcome>
  rebaseInteractive(repoPath: string, base: string, items: RebaseTodoItem[]): Promise<void>
  cherryPick(repoPath: string, hash: string): Promise<void>
  revertCommit(repoPath: string, hash: string): Promise<void>
  reset(repoPath: string, hash: string, mode: ResetMode): Promise<void>
  /**
   * Undo the last history-changing operation (commit, amend, merge, rebase,
   * cherry-pick, revert, reset), restoring the branch to where it was without
   * losing uncommitted work — see main/git/undo.ts. Resolves with the message
   * to restore into the composer (commit/amend) and a toast line; rejects with
   * a friendly message when there's nothing to undo or local changes are in the
   * way.
   */
  undo(repoPath: string): Promise<UndoResult>
  continueOp(repoPath: string, op: RepoOpKind): Promise<void>
  abortOp(repoPath: string, op: RepoOpKind): Promise<void>
  skipRebaseCommit(repoPath: string): Promise<void>
  resolveConflict(repoPath: string, path: string, side: 'ours' | 'theirs'): Promise<void>
  markResolved(repoPath: string, path: string): Promise<void>
  /** Both sides of a conflicted path, for the conflict-resolution panel. */
  conflictSides(repoPath: string, path: string): Promise<ConflictSides>
  /** Launch the user's configured merge tool for a conflicted path. */
  openMergeTool(repoPath: string, path: string): Promise<void>
  /** The configured `merge.tool` name, or null when git will auto-pick one. */
  mergeToolName(repoPath: string): Promise<string | null>
  /** Open a repo file with the OS default application. */
  openFileInEditor(repoPath: string, path: string): Promise<void>
  // ── Stash ──
  stashList(repoPath: string): Promise<StashEntry[]>
  stashSave(
    repoPath: string,
    opts?: { message?: string; includeUntracked?: boolean; paths?: string[] }
  ): Promise<void>
  /**
   * Files of a stash: tracked changes (vs the stash's first parent) plus the
   * untracked files git stores in the stash's third parent, marked untracked.
   */
  stashFiles(repoPath: string, sha: string): Promise<ChangedFile[]>
  stashApply(repoPath: string, index: number, pop: boolean): Promise<void>
  stashDrop(repoPath: string, index: number): Promise<void>
  // ── Tags ──
  createTag(
    repoPath: string,
    name: string,
    opts?: { hash?: string; message?: string; push?: boolean }
  ): Promise<void>
  deleteTag(repoPath: string, name: string): Promise<void>
  // ── Worktrees & submodules ──
  worktreeList(repoPath: string): Promise<WorktreeInfo[]>
  worktreeAdd(
    repoPath: string,
    path: string,
    opts?: { branch?: string; newBranch?: string }
  ): Promise<void>
  worktreeRemove(repoPath: string, path: string, opts?: { force?: boolean }): Promise<void>
  submoduleList(repoPath: string): Promise<SubmoduleInfo[]>
  submoduleUpdate(repoPath: string): Promise<void>
  // ── Git LFS ──
  /** Whether LFS works here: tracked patterns, filter config, binary. */
  lfsHealth(repoPath: string): Promise<LfsHealth>
  /** One-click LFS setup (`git lfs install`: global filters + repo hooks). */
  lfsEnable(repoPath: string): Promise<void>
  /** Enable git's large-repo features (fsmonitor, untracked cache, index v4). */
  optimizeRepo(repoPath: string): Promise<void>
  /** Sum of the on-disk sizes (bytes) of the given repo-relative paths. */
  selectionSize(repoPath: string, paths: string[]): Promise<number>
  // ── Clone ──
  /**
   * Clone `url` into `targetPath` — the exact directory the new repo lands in
   * (the dialog composes it as `<base>/<repo-name>` but the user can edit it).
   * A leading `~` is expanded. Progress arrives via onCloneProgress; resolves
   * to the path of the new repository.
   */
  cloneRepo(url: string, targetPath: string): Promise<string>
  /** Whether `targetPath` can be cloned into (missing/empty vs. occupied). */
  checkCloneTarget(targetPath: string): Promise<CloneTargetState>
  /**
   * A sensible parent folder to clone into, prefilled in the clone dialog: the
   * last folder the user cloned into, or `<home>/Projects` the first time.
   */
  defaultCloneDir(): Promise<string>
  /** Open the native directory picker; null when cancelled. */
  pickDirectory(title?: string): Promise<string | null>
  /**
   * Check whether git is available. Pass `force` to re-probe after the user has
   * (e.g.) installed git, bypassing the cached result.
   */
  checkGit(force?: boolean): Promise<GitAvailability>
  /** Open a URL in the user's default browser. */
  openExternal(url: string): Promise<void>
  /** Write text to the system clipboard. */
  clipboardWrite(text: string): Promise<void>
  /** Build/runtime info for the About dialog. */
  appInfo(): Promise<AppInfo>
  /** Ask the main process to check the update feed. `manual` drives "up to date" UI. */
  checkForUpdates(manual: boolean): Promise<void>
  /** Quit and install a downloaded update. */
  installUpdate(): Promise<void>
  /** Minimize the window (custom title-bar control on Windows/Linux). */
  windowMinimize(): Promise<void>
  /** Toggle maximize/restore (custom title-bar control on Windows/Linux). */
  windowMaximizeToggle(): Promise<void>
  /** Close the window (custom title-bar control on Windows/Linux). */
  windowClose(): Promise<void>
  /** Current maximize state, for picking the maximize vs. restore glyph. */
  windowIsMaximized(): Promise<boolean>
  /** Top-level application-menu labels, for the custom always-visible menu bar. */
  menuLabels(): Promise<string[]>
  /** Open a top-level menu's native submenu anchored at window coords (x, y). */
  menuPopup(label: string, x: number, y: number): Promise<void>
  /** Subscribe to maximize/restore changes. Returns an unsubscribe fn. */
  onWindowMaximized(handler: (maximized: boolean) => void): () => void
  /** Subscribe to filesystem-driven repo change notifications. Returns an unsubscribe fn. */
  onRepoChanged(handler: (repoPath: string) => void): () => void
  /** Subscribe to the application menu "Open Repository" command. */
  onMenuOpenRepo(handler: () => void): () => void
  /** Subscribe to the "About GitGrove" menu command. */
  onShowAbout(handler: () => void): () => void
  /** Subscribe to generic application-menu commands (fetch, pull, stash, …). */
  onMenuCommand(handler: (command: MenuCommand) => void): () => void
  /** Subscribe to clone progress pushes while a clone runs. */
  onCloneProgress(handler: (progress: CloneProgress) => void): () => void
  /** Subscribe to credential prompts from running network operations. */
  onCredentialPrompt(handler: (request: CredentialPromptRequest) => void): () => void
  /** Subscribe to credential prompt dismissals (prompt expired unanswered). */
  onCredentialDismiss(handler: (requestId: string) => void): () => void
  /** Subscribe to device-flow user codes while a sign-in runs. */
  onAccountDeviceCode(handler: (info: DeviceCodeInfo) => void): () => void
  /** Subscribe to connected-account list changes. Returns an unsubscribe fn. */
  onAccountsChanged(handler: () => void): () => void
  /** Subscribe to repo-listing pages as they stream in. Returns an unsubscribe fn. */
  onAccountReposPage(handler: (page: RemoteRepoPage) => void): () => void
  /** Subscribe to determinate progress of running checkout/fetch/pull/push ops. */
  onOpProgress(handler: (progress: OpProgress) => void): () => void
  /** Subscribe to auto-update lifecycle pushes. Returns an unsubscribe fn. */
  onUpdateStatus(handler: (status: UpdateStatus) => void): () => void
}

declare global {
  interface Window {
    gitgrove: GitGroveApi
  }
}
