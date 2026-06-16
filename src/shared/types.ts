// Types shared between the Electron main process, the preload bridge, and the
// React renderer. Keep this file free of any runtime dependencies so it can be
// imported from every bundle.

/** Git status of a changed file, as shown across the app. */
export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'ignored'
  | 'conflicted'

export interface ChangedFile {
  /** Repo-relative POSIX path. For renames this is the new path. */
  path: string
  /** Previous path for renames/copies. */
  oldPath?: string
  status: FileStatus
  /** True when the change is staged in the index. */
  staged: boolean
  /** True when the file has both staged and unstaged portions. */
  partiallyStaged?: boolean
  /** Status of the staged (index) side, when staged. */
  indexStatus?: FileStatus
  /** Status of the unstaged (working-tree) side, when unstaged changes exist. */
  workingStatus?: FileStatus
  insertions?: number
  deletions?: number
  /** True when git considers the blob binary. */
  binary?: boolean
  /** True when the entry is a submodule (gitlink, mode 160000). */
  submodule?: boolean
}

/**
 * Which side of the index a working diff (or a stage/discard action) targets.
 * `all` is the legacy combined view (HEAD → working tree).
 */
export type DiffArea = 'staged' | 'unstaged' | 'all'

/** An in-progress multi-step operation that owns the working tree. */
export type RepoOpKind = 'merging' | 'rebasing' | 'cherry-picking' | 'reverting'

/**
 * What state the repository is in beyond "normal": merge/rebase/cherry-pick/
 * revert in progress, plus how many paths are still conflicted. The renderer
 * shows a banner with continue/abort while `op` is set.
 */
export interface RepoState {
  op: RepoOpKind | null
  /** Human description of the operation's source, e.g. the branch being merged. */
  detail?: string
  conflictedCount: number
}

/**
 * Everything the renderer needs after any repository change, gathered in
 * (almost) one git invocation — see main/git/status.ts. Replaces separate
 * status / branch-current / sync / repo-state / stash fetches.
 */
export interface RepoSnapshot {
  files: ChangedFile[]
  /** Current branch name, or the short HEAD sha when detached. */
  branch: string
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  remotes: string[]
  state: RepoState
  stashes: StashEntry[]
  /**
   * How long the underlying `git status` took (ms). Persistently high values
   * mean git's large-repo features (fsmonitor, untracked cache, index v4) are
   * off — the renderer offers to enable them.
   */
  statusMs: number
}

/** Upstream-tracking summary that drives the toolbar sync button. */
export interface SyncStatus {
  /** `origin/main`-style upstream ref, or null when the branch has none. */
  upstream: string | null
  ahead: number
  behind: number
  /** Configured remote names; empty means nothing to sync with. */
  remotes: string[]
}

export interface StashEntry {
  /** Position in the stash list (`stash@{N}`). */
  index: number
  /**
   * The stash commit's sha. A stash is a real commit whose diff against its
   * first parent is exactly the stashed change — so reviewing a stash reuses
   * the commit-diff machinery.
   */
  sha: string
  /** User-visible message. Empty for auto-stashes (the UI labels those itself). */
  message: string
  /**
   * Branch the stash was taken on, parsed from the subject git records
   * ("WIP on x: …" / "On x: …"); null when detached or unparseable. Lets the
   * UI say "these changes belong to this branch" without extra bookkeeping.
   */
  branchName: string | null
  /**
   * True when GitGrove created this stash itself to leave changes behind
   * while creating a branch — drives the welcome-back reminder shown when
   * the user returns to that branch.
   */
  auto: boolean
  relativeDate: string
}

export interface WorktreeInfo {
  path: string
  /** Checked-out branch, or null when detached. */
  branch: string | null
  headShort: string
  /** True for the main working tree (the repo itself). */
  isMain: boolean
  /** True when this worktree is the repo currently open in the app. */
  isCurrent: boolean
}

/**
 * Whether Git LFS works in a repository, probed on repo open. A repo whose
 * `.gitattributes` tracks files with the LFS filter silently breaks on a
 * machine missing the `git-lfs` binary or the smudge/clean filter config —
 * files materialize as pointer text, pushes drop content. The renderer shows
 * a one-click fix banner when `usesLfs` is true but the rest isn't.
 */
export interface LfsHealth {
  /** True when a `.gitattributes` routes patterns through the LFS filter. */
  usesLfs: boolean
  /** True when git config resolves the LFS smudge/clean filters (any scope). */
  filtersConfigured: boolean
  /** True when the `git-lfs` binary is reachable from git. */
  binaryAvailable: boolean
}

export interface SubmoduleInfo {
  path: string
  shaShort: string
  state: 'clean' | 'modified' | 'uninitialized' | 'conflict'
}

/**
 * What to do with uncommitted changes when switching branches (checking out
 * an existing branch, or creating and checking out a new one): bring them
 * along to the destination, or leave them behind on the current branch
 * (auto-stashed, restorable when the user returns).
 */
export type BranchChangesAction = 'bring' | 'leave'

/**
 * How a branch switch (checkout or create-and-checkout) ended. Same
 * conflicts-as-data contract as merges: 'conflicts' means the switch happened
 * and the brought-along changes mostly followed, but a few files need
 * resolving — a normal step, never presented as an error.
 */
export type CheckoutOutcome = 'completed' | 'conflicts'

/** What a checkout hands back: the refreshed branch state plus how it went. */
export interface CheckoutResult {
  branch: BranchInfo
  outcome: CheckoutOutcome
}

/** How a "merge branch into current" request should be performed. */
export type MergeKind = 'merge' | 'squash' | 'rebase'

/**
 * How a merge/rebase ended. Conflicts are modelled as data (not thrown) —
 * stopping to resolve conflicts is a normal step of the workflow, not an
 * error, and the renderer must never present it as one.
 */
export type MergeOutcome = 'completed' | 'up-to-date' | 'conflicts'

/**
 * Dry-run prediction of a merge, computed without touching the working tree
 * (`git merge-tree`). Shown before the user commits to the operation so a
 * merge is never a leap of faith. `unknown` = the running git predates
 * merge-tree --write-tree (< 2.38); the merge itself still works.
 */
export interface MergePreview {
  outcome: 'clean' | 'conflicts' | 'up-to-date' | 'unknown'
  /** Paths that would conflict (outcome 'conflicts'). */
  conflictedPaths: string[]
  /** Commits the source branch would bring in. */
  commitCount: number
}

/**
 * The three versions of a conflicted file, for the conflict-resolution panel:
 * full contents from the index's conflict stages — `base` (stage 1, the
 * common ancestor), `ours` (stage 2, HEAD) and `theirs` (stage 3, the branch
 * being merged). A side is null when it doesn't exist there (added on both
 * sides has no base; modify/delete has one side missing), or when the file
 * is binary or too large to ship.
 */
export interface ConflictSides {
  base: string | null
  ours: string | null
  theirs: string | null
  /** True when that side has no version of the file (modify/delete conflict).
   *  Distinct from a null content, which can also mean binary or too large. */
  oursDeleted: boolean
  theirsDeleted: boolean
  /** Number of `<<<<<<<` conflict regions left in the working-tree file. */
  markerCount: number
  binary: boolean
}

/** Per-commit instruction for an interactive rebase. */
export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface RebaseTodoItem {
  hash: string
  action: RebaseAction
  /** Replacement message for `reword` (and optionally `squash`). */
  message?: string
}

export type ResetMode = 'soft' | 'mixed' | 'hard'

/** Long-running git operations that report determinate progress. */
export type ProgressOpKind = 'checkout' | 'fetch' | 'pull' | 'push' | 'discard'

/**
 * Progress of a long-running operation (checkout / fetch / pull / push /
 * discard), pushed from main while it runs so the UI can fill determinately
 * instead of spinning blind.
 */
export interface OpProgress {
  repoPath: string
  kind: ProgressOpKind
  /** Phase reported by git, e.g. "Receiving objects". */
  phase: string
  /** 0–100 within the current phase. */
  percent: number
}

/** Progress of a `git clone`, pushed from main while a clone runs. */
export interface CloneProgress {
  /** Phase reported by git, e.g. "Receiving objects". */
  phase: string
  /** 0–100 within the current phase. */
  percent: number
  done: boolean
  error?: string
}

export interface Commit {
  hash: string
  shortHash: string
  subject: string
  body: string
  authorName: string
  authorEmail: string
  /** ISO date string. */
  date: string
  relativeDate: string
  refs: string
  parents: string[]
}

/**
 * One source line annotated with the commit that last touched it (git blame).
 * `filename`/`previous` are the file's path at the blamed commit and its prior
 * version — they let the renderer reblame across renames precisely. A line is
 * reblameable when `previous` is set and it's committed: boundary (root / walk
 * edge) and not-yet-committed working-tree lines have nothing earlier to blame.
 */
export interface BlameLine {
  hash: string
  shortHash: string
  authorName: string
  authorEmail: string
  /** ISO date string (author time). */
  date: string
  /** Commit subject (first line of the message). */
  summary: string
  /** 1-based line number in the blamed file. */
  lineNumber: number
  /** The line's text content. */
  content: string
  /** Path of the file at the blamed commit (for reblame across renames). */
  filename: string
  /** Parent commit + the file's path there, when git reports a prior version. */
  previous?: { hash: string; filename: string }
  /** Boundary commit (root commit, or the edge of a shallow/limited walk). */
  isBoundary?: boolean
  /** Uncommitted working-tree line — git's "Not Committed Yet". */
  notCommitted?: boolean
}

export interface BranchInfo {
  current: string
  detached: boolean
  /** Local branch names, most recently committed first. */
  local: string[]
  /** Remote branch names, most recently committed first. */
  remote: string[]
  /**
   * The repository's default branch (origin/HEAD, falling back to main/master),
   * or null when it can't be determined. Drives the switcher's DEFAULT section.
   */
  defaultBranch: string | null
  /**
   * Recently checked-out local branches (from the reflog), most recent first;
   * excludes the current and default branch. Drives the RECENT section.
   */
  recent: string[]
}

export interface RepoInfo {
  path: string
  name: string
}

export interface RepoSummary extends RepoInfo {
  branch: BranchInfo
  /** Number of uncommitted changes in the working tree. */
  changeCount: number
  ahead: number
  behind: number
}

export interface RecentRepo extends RepoInfo {
  lastOpened: number
}

/**
 * Outcome of trying to open a repo. Expected, recoverable cases are modelled as
 * data (not thrown) so the renderer can react: `not-git` shows an error,
 * `untrusted` (git "dubious ownership") prompts the user to trust the folder.
 */
export type RepoOpenResult =
  | { ok: true; summary: RepoSummary }
  | { ok: false; reason: 'not-git' | 'untrusted'; path: string }

export interface LogOptions {
  /** Branch / ref to read history from. Defaults to the checked-out branch. */
  ref?: string
  limit?: number
  skip?: number
  /** Free-text search across commit messages. */
  search?: string
}

/**
 * One side of an image diff, shipped ready to paint: a `data:` URL the
 * renderer feeds straight to an <img> (no file:// access from the sandboxed
 * renderer, no temp files), plus the encoded size for the info bar.
 */
export interface ImageContents {
  dataUrl: string
  /** Encoded size in bytes (the blob, not the decoded bitmap). */
  bytes: number
}

/**
 * Both sides of an image change. A null side means the image doesn't exist
 * there (added/untracked → no old, deleted → no new); the viewer renders a
 * single-image preview for those and the four-mode diff when both exist.
 */
export interface ImageDiffSides {
  old: ImageContents | null
  new: ImageContents | null
}

/** A single file's unified diff plus light metadata for the diff viewer. */
export interface DiffPayload {
  /** Unified git patch (with `diff --git` header), or empty when not diffable. */
  patch: string
  path: string
  oldPath?: string
  status: FileStatus
  binary: boolean
  /** Set when the file is too large / binary and no patch is produced. */
  notice?: string
  /**
   * Set when both sides of the diff are Git LFS pointers: the sizes (bytes) of
   * the real LFS objects, null meaning the file doesn't exist on that side.
   * The viewer renders an "LFS file" panel instead of raw pointer text.
   */
  lfs?: { oldSize: number | null; newSize: number | null }
  /**
   * Set when the diff is a submodule (gitlink) change: the commit movement,
   * null sides meaning added/removed, `dirty` meaning the submodule's own
   * working tree has uncommitted changes. The viewer renders a dedicated
   * submodule panel instead of raw "Subproject commit" plumbing text.
   */
  submodule?: { oldSha: string | null; newSha: string | null; dirty: boolean }
  /**
   * Set when the path is a renderable image (see main/git/image.ts): the
   * old/new contents as data URLs. The viewer swaps the text diff for the
   * image viewer (single preview or four-mode visual diff). For SVG the text
   * `patch`/contents are still shipped alongside, so the viewer can offer an
   * Image ⇄ Code toggle.
   */
  image?: ImageDiffSides
  language?: string
  /**
   * Full old/new file contents. When both are present the diff viewer renders
   * with @pierre/diffs' MultiFileDiff so collapsed context becomes expandable
   * (PatchDiff alone only has the patch's limited context). Omitted for binary,
   * too-large, or unreadable files, in which case the viewer falls back to the
   * non-expandable patch render.
   */
  oldContents?: string
  newContents?: string
}

/**
 * What the commit checkboxes selected: fully included paths plus standalone
 * hunk patches for partially included files.
 */
export interface CommitSelection {
  amend?: boolean
  /** Every (non-conflicted) changed file is fully included. */
  all: boolean
  paths: string[]
  patches: string[]
}

/**
 * A tracked file the user chose to discard. `oldPath`/`status` let the main
 * process treat renames (reset both sides, restore the old path, trash the
 * new one) and staged-new files (trash, nothing to restore) correctly.
 */
export interface DiscardItem {
  path: string
  oldPath?: string
  status: FileStatus
}

export interface AppError {
  message: string
  detail?: string
}

/** What kind of secret a git/ssh credential prompt is asking for. */
export type CredentialKind = 'username' | 'password' | 'passphrase'

/**
 * A git/ssh credential prompt, parsed from the raw prompt string (see
 * main/git/askpass-prompt.ts). The raw text never crosses to the renderer —
 * only this classification, so the dialog can show purposeful copy.
 */
export interface CredentialPrompt {
  kind: CredentialKind
  /** Host being authenticated against (https prompts). */
  host?: string
  /** Path of the SSH key being unlocked (passphrase prompts). */
  keyPath?: string
}

/**
 * A credential prompt pushed to the renderer while a network operation waits.
 * The renderer answers with `respondCredential(requestId, value | null)`;
 * null cancels, which makes the waiting git process abort cleanly.
 */
export interface CredentialPromptRequest extends CredentialPrompt {
  requestId: string
}

/** Git hosting providers GitGrove can connect accounts for. v1: GitHub (.com + Enterprise). */
export type AccountProvider = 'github'

/**
 * A connected git-host account, as the renderer sees it: metadata only. The
 * access token stays in the main process (encrypted at rest via safeStorage)
 * and is served to git through the askpass responder — it never crosses the
 * IPC boundary.
 */
export interface ConnectedAccount {
  /** Stable identifier: `${host}/${login}`. */
  id: string
  provider: AccountProvider
  /** Host the account authenticates, e.g. `github.com` or a GHES hostname. */
  host: string
  login: string
  name: string | null
  /** Primary email when readable — also used to prefill the commit identity. */
  email: string | null
  /** OAuth scopes the token carries (informational, shown in the UI). */
  scopes: string[]
  /**
   * False when OS-level encryption was unavailable (no Linux keyring): the
   * token is kept in memory for this session only, never written to disk.
   */
  persisted: boolean
}

/**
 * Outcome of resolving a commit email to a host avatar via the connected
 * account's API. `ok: false` means a transient failure (network, rate limit,
 * bad token) — the renderer must retry later, never cache it. `ok: true`
 * with a null url is a definite "this host has no user for that email" and
 * is safe to cache for the session.
 */
export interface AvatarLookupResult {
  ok: boolean
  url: string | null
}

/**
 * The user-facing half of a device-flow sign-in: the code to type and where.
 * Pushed to the renderer while the main process polls for the authorization.
 */
export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  /** Epoch ms when the code expires (drives the dialog's countdown). */
  expiresAt: number
}

/** Why connecting an account failed — stable codes the UI maps to copy. */
export type AccountErrorCode =
  | 'access-denied'
  | 'expired'
  | 'network'
  | 'bad-token'
  | 'bad-client-id'
  | 'cancelled'

/**
 * Outcome of connecting an account. Expected failures (user denied, code
 * expired, bad token…) are modelled as data — same pattern as RepoOpenResult —
 * so the renderer reacts without parsing error strings.
 */
export type AddAccountResult =
  | { ok: true; account: ConnectedAccount }
  | { ok: false; code: AccountErrorCode }

/**
 * The commit identity resolved from git config, with where it came from.
 * `source: 'none'` means name or email is missing — a commit would fail with
 * git's "Please tell me who you are" error, so the UI collects them first.
 */
export interface GitIdentity {
  name: string
  email: string
  source: 'local' | 'global' | 'none'
}

/** Where setIdentity writes: the user's global config or just this repo's. */
export type IdentityScope = 'global' | 'local'

/**
 * The machine-wide identity from the global git config (Settings → Identity).
 * Unlike GitIdentity this never includes repo-local overrides, so editing it
 * edits exactly what every repository without an override will use.
 */
export interface GlobalIdentity {
  name: string
  email: string
}

/**
 * Whether a usable `git` executable was found, used to gate the UI: when git is
 * missing the renderer shows a guided setup screen instead of letting the user
 * hit cryptic failures on every repo action.
 */
export interface GitAvailability {
  available: boolean
  /** Resolved git version (e.g. `2.53.0`) when available. */
  version?: string
  /** Path / command used to invoke git (`'git'` when found on PATH). */
  path?: string
  /** Host platform, so the setup screen can show OS-specific install guidance. */
  platform: NodeJS.Platform
}

/** Static information about the running build, surfaced in the About dialog. */
export interface AppInfo {
  name: string
  version: string
  /** Electron / Chromium / Node / V8 runtime versions. */
  electron: string
  chrome: string
  node: string
  v8: string
  platform: NodeJS.Platform
  arch: string
  /** False when running a packaged build, true under `electron-vite dev`. */
  dev: boolean
  /** Canonical repository URL for "View on GitHub" links. */
  repoUrl: string
}

/** Lifecycle of an auto-update check, pushed from main to the renderer. */
export type UpdateState =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  /**
   * The update finished downloading but can't be auto-installed: an unsigned
   * macOS build, which Squirrel.Mac refuses to validate. The user finishes by
   * opening the downloaded installer (.dmg) themselves — see `downloadedFile`.
   */
  | 'manual-install'
  | 'error'
  /** Reported for manual checks while running an unpackaged dev build. */
  | 'dev'

export interface UpdateStatus {
  state: UpdateState
  /** The currently running version. */
  version: string
  /** The version offered by the feed (available / downloaded states). */
  newVersion?: string
  /** Release notes for the offered version, flattened to plain text. */
  notes?: string
  /** Download progress 0–100 (downloading state). */
  percent?: number
  bytesPerSecond?: number
  /** Absolute path to the downloaded installer (manual-install state). */
  downloadedFile?: string
  error?: string
  /**
   * True when the user explicitly asked to check (menu / About button). Lets the
   * renderer stay silent about "up to date" results from background checks.
   */
  manual: boolean
}
