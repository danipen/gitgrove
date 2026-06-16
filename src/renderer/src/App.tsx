import type { MenuCommand } from '@shared/ipc'
import type {
  AppInfo,
  BranchChangesAction,
  BranchInfo,
  ChangedFile,
  CheckoutOutcome,
  Commit,
  CredentialPromptRequest,
  GitAvailability,
  IdentityScope,
  LfsHealth,
  MergeKind,
  MergeOutcome,
  ProgressOpKind,
  RepoOpenResult,
  RepoSnapshot,
  RepoState,
  RepoSummary,
  StashEntry,
  SyncStatus
} from '@shared/types'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { AboutDialog } from './components/app/AboutDialog'
import { AppModals, type Modal } from './components/app/AppModals'
import { CloneDialog } from './components/app/CloneDialog'
import type { CreateBranchRequest } from './components/app/CreateBranchDialog'
import { CredentialDialog } from './components/app/CredentialDialog'
import { GitSetup } from './components/app/GitSetup'
import { IdentityDialog } from './components/app/IdentityDialog'
import { LfsBanner } from './components/app/LfsBanner'
import { TrustDialog } from './components/app/TrustDialog'
import { UpdateBanner } from './components/app/UpdateBanner'
import { Welcome } from './components/app/Welcome'
import { ChangesView } from './components/changes/ChangesView'
import { ConflictPanel } from './components/changes/ConflictPanel'
import type { ContextMenuItem } from './components/common/ContextMenu'
import { type DiffMode, DiffViewer } from './components/common/DiffViewer'
import { Resizer } from './components/common/Resizer'
import { Toast } from './components/common/Toast'
import { TooltipLayer } from './components/common/TooltipLayer'
import { CommitSummary } from './components/history/CommitSummary'
import { commitMenuItems } from './components/history/commitMenuItems'
import { FileHistoryOverlay, type FileHistoryTarget } from './components/history/FileHistoryOverlay'
import { HistoryView } from './components/history/HistoryView'
import { SettingsDialog } from './components/settings/SettingsDialog'
import type { BranchAction } from './components/toolbar/BranchSwitcher'
import type { SyncAction } from './components/toolbar/SyncButton'
import { Toolbar } from './components/toolbar/Toolbar'
import {
  buildCommitSelection,
  buildStashSelection,
  type FileSelection
} from './lib/commit-selection'
import { Icon } from './lib/icons'
import { mergeSourceFromDetail } from './lib/merge'
import { usePersistentState } from './lib/persist'
import { overallPercent } from './lib/progress'
import { useTheme } from './lib/theme'
import { useDiffLoader } from './lib/useDiffLoader'
import { useUpdateBanner } from './lib/useUpdateBanner'

type Tab = 'changes' | 'history'

const LOG_LIMIT = 300
/** Background fetch cadence (ms) — quiet, skipped while an op runs. */
const AUTO_FETCH_INTERVAL = 10 * 60 * 1000

export function App() {
  const [repo, setRepo] = useState<RepoSummary | null>(null)
  const [branch, setBranch] = useState<BranchInfo | null>(null)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Positive feedback (merge completed, already up to date, …) — the calm
  // green counterpart of the error toast, so successful operations never end
  // in silence.
  const [notice, setNotice] = useState<string | null>(null)

  // Git availability gates the whole UI: null = checking, then a setup screen
  // when git is missing (see the render gate below).
  const [git, setGit] = useState<GitAvailability | null>(null)
  const [gitChecking, setGitChecking] = useState(false)

  // Path of a folder git flagged as untrusted ("dubious ownership"); set to show
  // the trust prompt, with `trusting` true while persisting the exception.
  const [trustPath, setTrustPath] = useState<string | null>(null)
  const [trusting, setTrusting] = useState(false)

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  // The File History / Blame overlay target, or null when closed.
  const [fileHistory, setFileHistory] = useState<FileHistoryTarget | null>(null)
  const openFileHistory = useCallback(
    (path: string, mode: 'diff' | 'blame', baseRef: string | null) =>
      setFileHistory({ path, mode, baseRef }),
    []
  )

  const [tab, setTab] = useState<Tab>('changes')

  const [changes, setChanges] = useState<ChangedFile[]>([])
  const [changesLoading, setChangesLoading] = useState(false)
  // Selected working file (repo-relative path).
  const [changeSel, setChangeSel] = useState<string | null>(null)
  // File-list selection sizes per tab — drive the "multiple files selected"
  // diff state. The list owns multi-selection; it reports just the count up.
  const [changeSelCount, setChangeSelCount] = useState(1)

  // Write-side repo state: in-progress op, upstream tracking, stashes.
  const [repoState, setRepoState] = useState<RepoState | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [stashes, setStashes] = useState<StashEntry[]>([])
  const [syncRunning, setSyncRunning] = useState<SyncAction | null>(null)
  // Determinate progress of the op this window started (checkout/fetch/pull/
  // push), already mapped onto one 0–100 scale; null while idle or before git
  // reports anything.
  const [opProgress, setOpProgress] = useState<{ kind: ProgressOpKind; percent: number } | null>(
    null
  )
  // Branch a checkout is switching to, for the switcher's progress display.
  const [checkingOut, setCheckingOut] = useState<string | null>(null)
  // Git LFS health of the open repo (null = not probed / not applicable) and
  // whether the user waved the banner away for this repo session.
  const [lfsHealth, setLfsHealth] = useState<LfsHealth | null>(null)
  const [lfsDismissed, setLfsDismissed] = useState(false)
  const [lfsEnabling, setLfsEnabling] = useState(false)
  const [modal, setModal] = useState<Modal | null>(null)
  const [modalBusy, setModalBusy] = useState(false)

  // Credential prompts pushed from main while a network op waits on auth.
  // A queue because git asks in steps (username, then password) and parallel
  // ops can overlap — the dialog shows them one at a time, oldest first.
  // `oauth` marks prompts whose host supports one-click browser sign-in.
  const [credentialPrompts, setCredentialPrompts] = useState<
    Array<CredentialPromptRequest & { oauth: boolean }>
  >([])

  const [commits, setCommits] = useState<Commit[]>([])
  const [commitsLoading, setCommitsLoading] = useState(false)
  // Infinite scroll: whether older commits may exist past what's loaded, and
  // whether a "load more" page is currently in flight (bottom spinner).
  const [logHasMore, setLogHasMore] = useState(false)
  const [commitsLoadingMore, setCommitsLoadingMore] = useState(false)
  const [logLoaded, setLogLoaded] = useState(false)
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null)
  const [commitFiles, setCommitFiles] = useState<ChangedFile[]>([])
  const [commitFilesLoading, setCommitFilesLoading] = useState(false)
  const [commitSelPath, setCommitSelPath] = useState<string | null>(null)
  const [commitSelCount, setCommitSelCount] = useState(1)

  // Commit-selection request token: selecting a commit fires an async
  // `commitFiles` fetch, and a slow one can resolve after the user has already
  // picked another commit. This token lets a superseded selection bail out.
  const commitReq = useRef(0)

  const [sidebarWidth, setSidebarWidth] = usePersistentState('gg.sidebarWidth', 340)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [diffMode, setDiffMode] = usePersistentState<DiffMode>('gg.diffMode', 'split')
  const [diffWrap, setDiffWrap] = usePersistentState('gg.diffWrap', false)
  const { pref: themePref, resolved: theme, setPref: setThemePref } = useTheme()

  const repoRef = useRef<RepoSummary | null>(null)
  repoRef.current = repo
  // Refs so the filesystem-driven refresh can read the latest view without
  // being re-created (which would re-subscribe the watcher).
  const tabRef = useRef<Tab>(tab)
  tabRef.current = tab
  const changeSelRef = useRef<string | null>(changeSel)
  changeSelRef.current = changeSel
  const changesRef = useRef<ChangedFile[]>(changes)
  changesRef.current = changes
  // Refs for the re-select guards: clicking the already-focused file/commit
  // must be a no-op instead of refetching (and flashing) an identical diff.
  const commitSelPathRef = useRef<string | null>(commitSelPath)
  commitSelPathRef.current = commitSelPath
  const selectedCommitRef = useRef<Commit | null>(selectedCommit)
  selectedCommitRef.current = selectedCommit
  // Hash whose file list is loaded (or loading); null after a failed fetch so
  // re-clicking the commit retries.
  const commitFilesHashRef = useRef<string | null>(null)
  const logLoadedRef = useRef(logLoaded)
  logLoadedRef.current = logLoaded
  // Mirrors for the pager: read the latest list/`hasMore` without re-creating
  // `loadMoreLog` (its identity stays stable across appends).
  const commitsRef = useRef<Commit[]>(commits)
  commitsRef.current = commits
  const logHasMoreRef = useRef(logHasMore)
  logHasMoreRef.current = logHasMore
  // Re-entrancy guard for the pager + a token so a full log reload (branch
  // switch, refresh) invalidates any in-flight "load more" page: appending a
  // stale page from another branch would corrupt the list.
  const loadingMoreRef = useRef(false)
  const logReq = useRef(0)
  const branchRef = useRef<BranchInfo | null>(branch)
  branchRef.current = branch
  // Ref so doCommit can route a mid-merge commit without re-creating on every
  // snapshot refresh.
  const repoStateRef = useRef<RepoState | null>(repoState)
  repoStateRef.current = repoState
  const syncRef = useRef<SyncStatus | null>(sync)
  syncRef.current = sync
  const busyRef = useRef(busy)
  busyRef.current = busy
  const branchesLoadingRef = useRef(false)
  // Refresh coalescing: one in flight at a time; triggers that arrive while it
  // runs collapse into a single trailing run (watcher + focus + post-op can
  // otherwise stack three status passes on big repos).
  const refreshInFlight = useRef(false)
  const refreshQueued = useRef(false)
  // The commit selection: checkboxes are pure renderer state — every changed
  // file defaults to included; toggling never touches git. Missing key =
  // 'all'; 'none' = excluded; a Map = selected hunk indexes with their
  // commit patches.
  const [selections, setSelections] = useState<Map<string, FileSelection>>(new Map())

  const fail = useCallback((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e)
    setError(message)
  }, [])

  const updates = useUpdateBanner(aboutOpen, fail)

  const getRepoPath = useCallback(() => repoRef.current?.path, [])
  const { diff, diffRef, diffLoading, loadWorkingDiff, loadCommitDiff, clearDiff } = useDiffLoader(
    getRepoPath,
    fail
  )

  // ── Data loaders ─────────────────────────────────────────────────────────
  // One IPC round-trip refreshes everything the sidebar shows: files, current
  // branch, ahead/behind, op state and stashes (a single `git status
  // --porcelain=2 --branch` plus config/reflog reads in the main process).
  // This is what keeps refreshes usable on 90k-file repositories.
  const applySnapshot = useCallback((snap: RepoSnapshot): ChangedFile[] => {
    setChanges(snap.files)
    setRepoState(snap.state)
    setSync({
      upstream: snap.upstream,
      ahead: snap.ahead,
      behind: snap.behind,
      remotes: snap.remotes
    })
    setStashes(snap.stashes)
    // Keep the displayed branch fresh without enumerating all branches — the
    // full list is loaded lazily when the switcher opens.
    setBranch((prev) =>
      prev
        ? { ...prev, current: snap.branch, detached: snap.detached }
        : {
            current: snap.branch,
            detached: snap.detached,
            local: [],
            remote: [],
            defaultBranch: null,
            recent: []
          }
    )
    return snap.files
  }, [])

  const loadSnapshot = useCallback(
    async (repoPath: string) =>
      applySnapshot(JSON.parse(await window.gitgrove.snapshot(repoPath)) as RepoSnapshot),
    [applySnapshot]
  )

  const loadBranches = useCallback(async (repoPath: string) => {
    if (branchesLoadingRef.current) return null
    branchesLoadingRef.current = true
    setBranchesLoading(true)
    try {
      const info = await window.gitgrove.branches(repoPath)
      setBranch(info)
      return info
    } finally {
      branchesLoadingRef.current = false
      setBranchesLoading(false)
    }
  }, [])

  /** Lazy branch enumeration: runs when the switcher opens, never on refresh. */
  const reloadBranches = useCallback(() => {
    const repoPath = repoRef.current?.path
    if (repoPath) loadBranches(repoPath)?.catch(() => {})
  }, [loadBranches])

  const loadLog = useCallback(
    async (repoPath: string, ref?: string, opts?: { keepCount?: boolean }) => {
      // `keepCount` (watcher/post-op refresh): re-fetch everything the user has
      // already paged in, so the list never shrinks back to the first page and
      // yanks their scroll position. Fresh loads reset to one page.
      const limit = opts?.keepCount ? Math.max(LOG_LIMIT, commitsRef.current.length) : LOG_LIMIT
      const id = ++logReq.current
      setCommitsLoading(true)
      try {
        const log = await window.gitgrove.log(repoPath, { limit, ref })
        if (id === logReq.current) {
          setCommits(log)
          // A short page means we hit the root commit — nothing left to page in.
          setLogHasMore(log.length >= limit)
          setLogLoaded(true)
        }
        return log
      } finally {
        if (id === logReq.current) setCommitsLoading(false)
      }
    },
    []
  )

  /** Appends the next page of history when the list scrolls near the bottom. */
  const loadMoreLog = useCallback(async () => {
    const repoPath = repoRef.current?.path
    if (!repoPath || loadingMoreRef.current || !logHasMoreRef.current) return
    loadingMoreRef.current = true
    const id = logReq.current
    setCommitsLoadingMore(true)
    try {
      const page = await window.gitgrove.log(repoPath, {
        limit: LOG_LIMIT,
        skip: commitsRef.current.length
      })
      // A reload (branch switch / refresh) raced us: drop this stale page.
      if (id !== logReq.current) return
      setLogHasMore(page.length >= LOG_LIMIT)
      if (page.length > 0) {
        setCommits((prev) => {
          // `--skip` is offset-based, so a commit landing upstream mid-scroll
          // shifts the window and can hand us rows we already have — dedupe to
          // keep React keys (and the list) clean.
          const seen = new Set(prev.map((c) => c.hash))
          const fresh = page.filter((c) => !seen.has(c.hash))
          return fresh.length > 0 ? [...prev, ...fresh] : prev
        })
      }
    } catch (e) {
      fail(e)
    } finally {
      loadingMoreRef.current = false
      setCommitsLoadingMore(false)
    }
  }, [fail])

  // ── Selection handlers ─────────────────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffRef is read for its live value, not as a trigger — depending on it would churn this handler on every diff load.
  const selectWorkingFile = useCallback(
    (path: string | null, list?: ChangedFile[], opts?: { force?: boolean }) => {
      // null = the list selection was emptied (Cmd/Ctrl+click on the last row).
      if (path === null) {
        setChangeSel(null)
        clearDiff()
        return
      }
      const file = (list ?? changes).find((f) => f.path === path)
      if (!file) return
      // Re-clicking the focused file is a no-op: its working diff is already
      // showing (refresh keeps it fresh), so reloading only flashes the pane.
      // `force` bypasses this for tab switches, where the pane may hold a
      // commit diff for the same path.
      if (!opts?.force && path === changeSelRef.current && diffRef.current?.path === path) return
      setChangeSel(path)
      loadWorkingDiff(file)
    },
    [changes, loadWorkingDiff, clearDiff]
  )

  /** Default selection: the first file (the snapshot arrives path-sorted). */
  const autoSelect = useCallback(
    (files: ChangedFile[], applyDiff: boolean) => {
      const first = files[0]
      if (!first) {
        setChangeSel(null)
        // The list went empty (last change committed/discarded) — clear the
        // pane too, but only when it's showing a working diff; in History it
        // holds a commit diff the user may be reading.
        if (applyDiff) clearDiff()
        return
      }
      if (applyDiff) selectWorkingFile(first.path, files)
      else setChangeSel(first.path)
    },
    [selectWorkingFile, clearDiff]
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: diffRef is read for its live value, not as a trigger — depending on it would churn this handler on every diff load.
  const selectCommitFile = useCallback(
    (path: string, hash: string, list?: ChangedFile[], opts?: { force?: boolean }) => {
      const file = (list ?? commitFiles).find((f) => f.path === path)
      if (!file) return
      // Commit diffs are immutable — re-clicking the focused file would only
      // reload the identical payload and flash the pane. `force` bypasses this
      // for tab switches (the pane may hold a working diff for the same path)
      // and for cross-commit auto-selects of the same path.
      if (!opts?.force && path === commitSelPathRef.current && diffRef.current?.path === path) {
        return
      }
      setCommitSelPath(path)
      loadCommitDiff(hash, file)
    },
    [commitFiles, loadCommitDiff]
  )

  const selectCommit = useCallback(
    async (commit: Commit) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return
      // Re-selecting the selected commit (click or right-click) is a no-op —
      // its file list and diff are immutable and already loaded (or loading).
      // Still adopt the new object: a refreshed log may carry updated refs.
      if (
        commit.hash === selectedCommitRef.current?.hash &&
        commitFilesHashRef.current === commit.hash
      ) {
        setSelectedCommit(commit)
        return
      }
      const id = ++commitReq.current
      commitFilesHashRef.current = commit.hash
      setSelectedCommit(commit)
      setCommitSelPath(null)
      setCommitFiles([])
      setCommitFilesLoading(true)
      try {
        const files = await window.gitgrove.commitFiles(repoPath, commit.hash)
        // A newer commit was selected while this one was loading — drop the
        // stale result so it can't overwrite the current commit's state.
        if (id !== commitReq.current) return
        setCommitFiles(files)
        // Force: the previous commit may have focused the same path, whose
        // (different) diff must not be kept.
        if (files.length > 0) selectCommitFile(files[0].path, commit.hash, files, { force: true })
        else clearDiff()
      } catch (e) {
        if (id === commitReq.current) {
          commitFilesHashRef.current = null
          fail(e)
        }
      } finally {
        if (id === commitReq.current) setCommitFilesLoading(false)
      }
    },
    [fail, selectCommitFile, clearDiff]
  )

  // ── Tab switching keeps the right pane in sync with the active selection ───
  const switchTab = useCallback(
    (next: Tab) => {
      setTab(next)
      // Both sidebar panes stay mounted (the inactive one is just hidden), so
      // each tab keeps its own draft, filters and multi-selection across the
      // switch. All that's left to do is re-point the shared diff pane at the
      // active tab's current selection.
      if (next === 'changes') {
        if (changeSel) selectWorkingFile(changeSel, undefined, { force: true })
        else clearDiff()
      } else {
        // First visit to History: fetch the log on demand.
        const repoPath = repoRef.current?.path
        if (repoPath && !logLoaded && !commitsLoading) loadLog(repoPath).catch(fail)
        if (selectedCommit && commitSelPath)
          selectCommitFile(commitSelPath, selectedCommit.hash, undefined, { force: true })
        else clearDiff()
      }
    },
    [
      changeSel,
      commitSelPath,
      selectedCommit,
      logLoaded,
      commitsLoading,
      loadLog,
      selectWorkingFile,
      selectCommitFile,
      clearDiff,
      fail
    ]
  )

  // ── Refresh: pulls every panel up to date (watcher + post-op) ─────────────
  const refresh = useCallback(async () => {
    const repoPath = repoRef.current?.path
    if (!repoPath) return
    if (refreshInFlight.current) {
      refreshQueued.current = true
      return
    }
    refreshInFlight.current = true
    setRefreshing(true)
    try {
      // Refresh the log only while History is actually visible; otherwise just
      // mark it stale so the next visit refetches. Branch enumeration is NOT
      // part of a refresh — the switcher reloads it lazily when opened.
      const refreshLog = logLoadedRef.current && tabRef.current === 'history'
      if (logLoadedRef.current && !refreshLog) setLogLoaded(false)
      const [files] = await Promise.all([
        loadSnapshot(repoPath),
        refreshLog ? loadLog(repoPath, undefined, { keepCount: true }) : Promise.resolve(null)
      ])
      // Keep the working selection valid; only re-fetch its diff when the
      // Changes tab is actually showing it, so a background edit never clobbers
      // a commit diff the user is reading in History.
      const current = changeSelRef.current
      const stillThere = current ? files.find((f) => f.path === current) : undefined
      if (current && !stillThere) {
        autoSelect(files, tabRef.current === 'changes')
      } else if (stillThere && tabRef.current === 'changes') {
        loadWorkingDiff(stillThere)
      }
    } catch (e) {
      fail(e)
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
      if (refreshQueued.current) {
        refreshQueued.current = false
        refreshRef.current()
      }
    }
  }, [loadSnapshot, loadLog, loadWorkingDiff, autoSelect, fail])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  /**
   * Run a mutating git operation: serialized behind `busy`, refreshed on
   * completion, errors surfaced as the standard toast. Resolves true on
   * success so callers can chain selection updates.
   */
  const runOp = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      if (busyRef.current) return false
      setBusy(true)
      try {
        await fn()
        await refreshRef.current()
        return true
      } catch (e) {
        fail(e)
        // The op may have half-applied (e.g. merge stopped on conflicts) —
        // refresh anyway so the UI shows the real state, banner included.
        await refreshRef.current().catch(() => {})
        return false
      } finally {
        setBusy(false)
      }
    },
    [fail]
  )

  // ── Repository lifecycle ───────────────────────────────────────────────────
  const applyRepo = useCallback(
    async (summary: RepoSummary) => {
      // `summary` carries only the current branch name (a cheap open); the full
      // branch list and status are fetched here so the repo switch itself is
      // instant and each panel shows its own progress.
      setRepo(summary)
      setBranch(summary.branch)
      setChanges([])
      setCommits([])
      setLogHasMore(false)
      setLogLoaded(false)
      setSelectedCommit(null)
      setCommitFiles([])
      setCommitSelPath(null)
      setChangeSel(null)
      setSelections(new Map())
      clearDiff()
      setRepoState(null)
      setSync(null)
      setStashes([])
      setModal(null)
      setFileHistory(null)
      // A repo switch abandons any commit waiting on the identity dialog; its
      // composer is still awaiting the promise, so settle it.
      pendingIdentityCommit.current?.resolve(false)
      pendingIdentityCommit.current = null
      setTab('changes')
      // Branch enumeration is the slowest part on big repos; let it fill in the
      // combo on its own so it never gates the first diff appearing.
      loadBranches(summary.path).catch(fail)
      setChangesLoading(true)
      try {
        const files = await loadSnapshot(summary.path)
        if (files.length > 0) autoSelect(files, tabRef.current === 'changes')
      } catch (e) {
        fail(e)
      } finally {
        setChangesLoading(false)
      }
    },
    [loadSnapshot, loadBranches, autoSelect, clearDiff, fail]
  )

  // Route an open outcome: success applies the repo, an untrusted folder opens
  // the trust prompt, and a non-repo surfaces the familiar error.
  const handleOpen = useCallback(
    (res: RepoOpenResult) => {
      if (res.ok) applyRepo(res.summary)
      else if (res.reason === 'untrusted') setTrustPath(res.path)
      else setError('The selected folder is not a git repository.')
    },
    [applyRepo]
  )

  const pickRepo = useCallback(async () => {
    try {
      const res = await window.gitgrove.pickRepo()
      if (res) handleOpen(res)
    } catch (e) {
      fail(e)
    }
  }, [handleOpen, fail])

  const openRepoByPath = useCallback(
    async (path: string) => {
      try {
        handleOpen(await window.gitgrove.openRepo(path))
      } catch (e) {
        fail(e)
      }
    },
    [handleOpen, fail]
  )

  const confirmTrust = useCallback(async () => {
    if (!trustPath) return
    setTrusting(true)
    try {
      const res = await window.gitgrove.trustRepo(trustPath)
      setTrustPath(null)
      handleOpen(res)
    } catch (e) {
      setTrustPath(null)
      fail(e)
    } finally {
      setTrusting(false)
    }
  }, [trustPath, handleOpen, fail])

  /** The switch itself: checkout, refresh, and narrate where the changes went. */
  const performCheckout = useCallback(
    async (name: string, changes?: BranchChangesAction) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return
      const previous = branchRef.current?.current ?? 'the previous branch'
      setBusy(true)
      setCheckingOut(name)
      try {
        const result = await window.gitgrove.checkout(
          repoPath,
          name,
          changes ? { changes } : undefined
        )
        setBranch(result.branch)
        setSelectedCommit(null)
        setCommitFiles([])
        setCommitSelPath(null)
        setChangeSel(null)
        setSelections(new Map())
        setCommits([])
        setLogHasMore(false)
        setLogLoaded(false)
        clearDiff()
        // The new branch invalidates the log; reload it now only if History is
        // showing, otherwise leave it for the next time the tab is opened.
        if (tabRef.current === 'history') loadLog(repoPath).catch(fail)
        const files = await loadSnapshot(repoPath)
        if (files.length > 0) autoSelect(files, tabRef.current === 'changes')
        // 'conflicts' is data, not an error (see CheckoutOutcome) — the files
        // arrive marked conflicted in the refreshed snapshot.
        if (result.outcome === 'conflicts') {
          setNotice(
            `Switched to ${name} and brought your changes — a few files need a quick ` +
              'conflict resolution.'
          )
        } else if (changes === 'leave') {
          setNotice(`Switched to ${name} — your changes stayed on ${previous}, safe in a stash.`)
        } else if (changes === 'bring') {
          setNotice(`Switched to ${name} — your changes came along.`)
        }
      } catch (e) {
        fail(e)
      } finally {
        setBusy(false)
        setCheckingOut(null)
      }
    },
    [loadSnapshot, loadLog, autoSelect, clearDiff, fail]
  )

  /**
   * Entry point for every branch switch: a dirty working tree first asks what
   * should happen to the pending changes (the switch-branch dialog); a clean
   * one — or one owned by an in-flight op, which git itself arbitrates —
   * switches straight away. Detached HEAD also goes straight through: there
   * is no branch to leave changes on.
   */
  const checkout = useCallback(
    (name: string) => {
      const dirty = changesRef.current.length > 0
      if (dirty && !repoStateRef.current?.op && !branchRef.current?.detached) {
        setModal({ kind: 'switch-branch', name })
        return
      }
      performCheckout(name)
    },
    [performCheckout]
  )

  /** Switch-branch dialog confirmed: close it and run the choreographed switch. */
  const performSwitchBranch = useCallback(
    (name: string, changes: BranchChangesAction) => {
      setModal(null)
      performCheckout(name, changes)
    },
    [performCheckout]
  )

  // ── Commit, hunks, sync, branch & history actions ──────────────────────────
  // Repos whose commit identity is known to be configured — checked once per
  // repo per session, so the config probe doesn't repeat on every commit.
  const identityOkRef = useRef(new Set<string>())
  // A commit interrupted by the identity dialog: its inputs plus the resolver
  // of the promise doCommit handed to the composer (which is still awaiting).
  const pendingIdentityCommit = useRef<{
    message: string
    amend: boolean
    resolve: (ok: boolean) => void
  } | null>(null)
  // Name/email from a connected account, offered as the identity default.
  const [identityPrefill, setIdentityPrefill] = useState<{ name: string; email: string } | null>(
    null
  )

  const doCommit = useCallback(
    async (message: string, amend: boolean) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return false
      // On a fresh machine git rejects the first commit with "Please tell me
      // who you are" — probe user.name/user.email up front and collect them
      // with one calm dialog instead of surfacing git's error. The commit
      // resumes (via doCommitRef) once the dialog saves the identity.
      if (!identityOkRef.current.has(repoPath)) {
        try {
          const identity = await window.gitgrove.getIdentity(repoPath)
          if (identity.source === 'none') {
            // A connected account already knows who the user is — prefill the
            // dialog so the common case is just pressing Enter.
            const accounts = await window.gitgrove.listAccounts().catch(() => [])
            const account = accounts.find((a) => a.email) ?? accounts[0] ?? null
            setIdentityPrefill(
              account ? { name: account.name ?? account.login, email: account.email ?? '' } : null
            )
            return new Promise<boolean>((resolve) => {
              pendingIdentityCommit.current = { message, amend, resolve }
              setModal({ kind: 'identity' })
            })
          }
          identityOkRef.current.add(repoPath)
        } catch {
          // Probe failed — let the commit itself surface the real error.
        }
      }
      // Mid-merge the commit button IS the merge's "continue": commit the whole
      // working tree (the merge result) and let MERGE_HEAD record the parents.
      // Checkbox selections don't apply — git refuses partial merge commits.
      if (repoStateRef.current?.op === 'merging') {
        const ok = await runOp(() => window.gitgrove.commitMerge(repoPath, message))
        if (ok) {
          setSelections(new Map())
          setNotice(`Merge completed on ${branchRef.current?.current ?? 'the current branch'}.`)
        }
        return ok
      }
      const sel = buildCommitSelection(changesRef.current, selections)
      const ok = await runOp(() => window.gitgrove.commit(repoPath, message, { amend, ...sel }))
      if (ok) setSelections(new Map())
      return ok
    },
    [runOp, selections]
  )
  const doCommitRef = useRef(doCommit)
  doCommitRef.current = doCommit

  /** Identity dialog confirmed: save it, then finish the interrupted commit. */
  const completeIdentitySetup = useCallback(
    async (name: string, email: string, scope: IdentityScope) => {
      const pending = pendingIdentityCommit.current
      pendingIdentityCommit.current = null
      setIdentityPrefill(null) // consumed — never let it leak into a later repo
      const repoPath = repoRef.current?.path
      if (!pending || !repoPath) {
        setModal(null)
        return
      }
      setModalBusy(true)
      try {
        await window.gitgrove.setIdentity(repoPath, name, email, scope)
        identityOkRef.current.add(repoPath)
      } catch (e) {
        setModalBusy(false)
        setModal(null)
        pending.resolve(false)
        fail(e)
        return
      }
      setModalBusy(false)
      setModal(null)
      pending.resolve(await doCommitRef.current(pending.message, pending.amend))
    },
    [fail]
  )

  const cancelIdentitySetup = useCallback(() => {
    pendingIdentityCommit.current?.resolve(false)
    pendingIdentityCommit.current = null
    setIdentityPrefill(null)
    setModal(null)
  }, [])

  /** Stash the checked files. When everything is checked, plain `git stash
   *  push -u` runs with no pathspec; otherwise the checked paths stream to
   *  git over stdin, untracked included. */
  const doStash = useCallback(
    async (message: string) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return false
      const { all, paths } = buildStashSelection(changesRef.current, selections)
      if (paths.length === 0) return false
      const ok = await runOp(() =>
        window.gitgrove.stashSave(repoPath, {
          message,
          includeUntracked: true,
          paths: all ? undefined : paths
        })
      )
      if (ok) setSelections(new Map())
      return ok
    },
    [runOp, selections]
  )

  // ── Commit selection (pure renderer state, zero git) ──────────────────────
  /** Toggle a file's checkbox: indeterminate/unchecked → included, checked → excluded. */
  const toggleFileIncluded = useCallback((path: string) => {
    setSelections((prev) => {
      const next = new Map(prev)
      const cur = prev.get(path) ?? 'all'
      if (cur === 'all') next.set(path, 'none')
      else next.delete(path) // 'none' or partial → fully included
      return next
    })
  }, [])

  /** Master checkbox: include/exclude every file, or just `paths` when filtering. */
  const setAllIncluded = useCallback((included: boolean, paths?: string[]) => {
    if (!paths) {
      setSelections(
        included
          ? new Map()
          : new Map(changesRef.current.map((f) => [f.path, 'none' as FileSelection]))
      )
      return
    }
    setSelections((prev) => {
      const next = new Map(prev)
      for (const p of paths) {
        if (included) next.delete(p)
        else next.set(p, 'none')
      }
      return next
    })
  }, [])

  // On-disk size of the included files — debounced; skipped on gigantic
  // selections so the stat pass stays trivial.
  const [commitSize, setCommitSize] = useState<number | null>(null)
  useEffect(() => {
    const repoPath = repoRef.current?.path
    if (!repoPath) return
    const t = setTimeout(() => {
      const paths: string[] = []
      for (const f of changes) {
        if (f.status === 'conflicted' || f.status === 'deleted') continue
        if ((selections.get(f.path) ?? 'all') !== 'none') paths.push(f.path)
      }
      if (paths.length === 0 || paths.length > 20000) {
        setCommitSize(paths.length === 0 ? 0 : null)
        return
      }
      window.gitgrove
        .selectionSize(repoPath, paths)
        .then(setCommitSize)
        .catch(() => setCommitSize(null))
    }, 400)
    return () => clearTimeout(t)
  }, [changes, selections])

  /** Replace one file's hunk selection (from the diff's checkbox bars). */
  const setHunkSelection = useCallback(
    (path: string, selected: Map<number, string>, totalHunks: number) => {
      setSelections((prev) => {
        const next = new Map(prev)
        if (selected.size === totalHunks) next.delete(path)
        else if (selected.size === 0) next.set(path, 'none')
        else next.set(path, selected)
        return next
      })
    },
    []
  )

  /** Discard a hunk in the working tree (reverse-apply its display patch). */
  const discardHunk = useCallback((patch: string) => {
    const repoPath = repoRef.current?.path
    if (!repoPath) return
    runOpRef.current(() => window.gitgrove.applyPatch(repoPath, patch, { reverse: true }))
  }, [])

  const doSync = useCallback(
    async (action: SyncAction) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return
      setSyncRunning(action)
      try {
        await runOp(() => {
          const gg = window.gitgrove
          switch (action) {
            case 'fetch':
              return gg.fetch(repoPath)
            case 'pull':
              return gg.pull(repoPath)
            case 'pull-rebase':
              return gg.pull(repoPath, { rebase: true })
            case 'push':
              return gg.push(repoPath)
            case 'force-push':
              return gg.push(repoPath, { forceWithLease: true })
            case 'publish': {
              const remotes = syncRef.current?.remotes ?? []
              const remote = remotes.includes('origin') ? 'origin' : remotes[0]
              const current = branchRef.current?.current
              if (!remote || !current) throw new Error('No remote to publish to.')
              return gg.push(repoPath, { setUpstream: { remote, branch: current } })
            }
          }
        })
      } finally {
        setSyncRunning(null)
      }
    },
    [runOp]
  )

  const runOpRef = useRef(runOp)
  runOpRef.current = runOp

  /**
   * Run the chosen merge strategy and narrate the outcome: completed and
   * already-up-to-date get a friendly notice, so a merge never ends in
   * silence. Stopping on conflicts is NOT an error — the in-progress banner
   * and the conflict panel take over from the refreshed snapshot.
   */
  const performMerge = useCallback(async (name: string, kind: MergeKind) => {
    const repoPath = repoRef.current?.path
    if (!repoPath) return
    const current = branchRef.current?.current ?? 'the current branch'
    setModalBusy(true)
    try {
      let outcome: MergeOutcome | null = null
      const ok = await runOpRef.current(async () => {
        outcome =
          kind === 'rebase'
            ? await window.gitgrove.rebase(repoPath, name)
            : await window.gitgrove.merge(repoPath, name, { squash: kind === 'squash' })
      })
      if (!ok) return
      if (outcome === 'up-to-date') {
        setNotice(`${current} is already up to date with ${name} — there was nothing to merge.`)
      } else if (outcome === 'completed') {
        setNotice(
          kind === 'merge'
            ? `Merged ${name} into ${current}.`
            : kind === 'squash'
              ? `Squashed ${name} into ${current} — review the staged changes and commit them.`
              : `Rebased ${current} onto ${name}.`
        )
      }
    } finally {
      setModalBusy(false)
      setModal(null)
    }
  }, [])

  /**
   * Create a branch from the dialog and narrate the outcome: where the changes
   * went, or that a few files need resolving ('conflicts' is data, not an
   * error). Checking out a new branch invalidates the log, same as checkout.
   */
  const performCreateBranch = useCallback(
    async (name: string, request: CreateBranchRequest) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return
      const previous = branchRef.current?.current ?? 'the previous branch'
      setModalBusy(true)
      try {
        let outcome: CheckoutOutcome | null = null
        const ok = await runOpRef.current(async () => {
          outcome = await window.gitgrove.createBranch(repoPath, name, request)
        })
        if (!ok) return
        if (request.checkout) {
          setLogLoaded(false)
          if (tabRef.current === 'history') loadLog(repoPath).catch(fail)
        }
        if (outcome === 'conflicts') {
          setNotice(
            `Created ${name} and brought your changes along — a few files need a quick ` +
              'conflict resolution.'
          )
        } else if (request.changes === 'leave') {
          setNotice(`Created ${name} — your changes stayed on ${previous}, ready for your return.`)
        } else if (request.changes === 'bring') {
          setNotice(`Created ${name} — your changes came along.`)
        }
      } finally {
        setModalBusy(false)
        setModal(null)
      }
    },
    [loadLog, fail]
  )

  const onBranchAction = useCallback(
    (action: BranchAction, name: string) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return
      switch (action) {
        case 'new':
          // The dialog's "start from the default branch" option needs a fresh
          // branch enumeration (defaultBranch is loaded lazily).
          reloadBranches()
          setModal({ kind: 'new-branch', initialName: name })
          break
        case 'merge':
          // Never merge blind: the dialog dry-runs the merge (conflicts known up
          // front) and offers merge / squash / rebase before anything happens.
          setModal({ kind: 'merge', name })
          break
        case 'rename':
          setModal({ kind: 'rename-branch', name })
          break
        case 'delete':
          setModal({ kind: 'delete-branch', name, force: false })
          break
      }
    },
    [reloadBranches]
  )

  /** Right-click menu for a history commit. */
  const commitMenuFor = useCallback(
    (commit: Commit): ContextMenuItem[] => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return []
      const gg = window.gitgrove
      return commitMenuItems(commit, commits, branchRef.current?.current ?? 'current branch', {
        checkoutCommit: (c) =>
          setModal({ kind: 'checkout-commit', hash: c.hash, shortHash: c.shortHash }),
        newBranchAt: (c) => setModal({ kind: 'new-branch', from: c.hash, fromLabel: c.shortHash }),
        createTagAt: (c) => setModal({ kind: 'create-tag', hash: c.hash, shortHash: c.shortHash }),
        cherryPick: (c) => runOpRef.current(() => gg.cherryPick(repoPath, c.hash)),
        revert: (c) => setModal({ kind: 'revert', hash: c.hash, shortHash: c.shortHash }),
        interactiveRebase: (chain, base) => setModal({ kind: 'irebase', commits: chain, base }),
        reset: (c, mode) => runOpRef.current(() => gg.reset(repoPath, c.hash, mode)),
        confirmHardReset: (c) =>
          setModal({ kind: 'reset', hash: c.hash, shortHash: c.shortHash, mode: 'hard' })
      })
    },
    [commits]
  )

  /** Run a modal-confirmed op: spinner while it runs, dialog closes either way
   *  (failures surface as the standard toast). */
  const runModalOp = useCallback(async (fn: () => Promise<unknown>) => {
    setModalBusy(true)
    try {
      await runOpRef.current(fn)
    } finally {
      setModalBusy(false)
      setModal(null)
    }
  }, [])

  const deleteBranch = useCallback(
    async (name: string, force: boolean) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return
      setModalBusy(true)
      try {
        await window.gitgrove.deleteBranch(repoPath, name, { force })
        setModal(null)
        await refreshRef.current()
      } catch (e) {
        // `-d` refuses unmerged branches; escalate to an explicit force confirm.
        if (!force && /not fully merged/i.test(e instanceof Error ? e.message : '')) {
          setModal({ kind: 'delete-branch', name, force: true })
        } else {
          setModal(null)
          fail(e)
        }
      } finally {
        setModalBusy(false)
      }
    },
    [fail]
  )

  const checkoutCommit = useCallback(
    async (hash: string) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return
      const ok = await runOpRef.current(() => window.gitgrove.checkoutDetached(repoPath, hash))
      setModal(null)
      // Detaching HEAD invalidates the log; reload it now only if History is
      // showing, otherwise leave it for the next time the tab is opened.
      if (ok) {
        setLogLoaded(false)
        if (tabRef.current === 'history') loadLog(repoPath).catch(fail)
      }
    },
    [loadLog, fail]
  )

  // ── Git availability: probe on launch, re-probe on demand ──────────────────
  useEffect(() => {
    window.gitgrove
      .checkGit()
      .then(setGit)
      .catch(() => setGit({ available: false, platform: 'win32' }))
  }, [])

  const recheckGit = useCallback(async () => {
    setGitChecking(true)
    try {
      setGit(await window.gitgrove.checkGit(true))
    } finally {
      setGitChecking(false)
    }
  }, [])

  // ── OS integration: menu commands + filesystem change notifications ────────
  useEffect(() => window.gitgrove.onMenuOpenRepo(() => pickRepo()), [pickRepo])

  useEffect(
    () =>
      window.gitgrove.onMenuCommand((command: MenuCommand) => {
        const hasRepo = !!repoRef.current
        switch (command) {
          case 'settings':
            setModal({ kind: 'settings' })
            break
          case 'clone':
            setModal({ kind: 'clone' })
            break
          case 'fetch':
          case 'pull':
          case 'push':
            if (hasRepo) doSync(command)
            break
          case 'new-branch':
            if (hasRepo) {
              // Fresh enumeration for the dialog's default-branch option.
              reloadBranches()
              setModal({ kind: 'new-branch' })
            }
            break
          case 'stash':
            if (hasRepo) setModal({ kind: 'stash' })
            break
          case 'worktrees':
            if (hasRepo) setModal({ kind: 'worktrees' })
            break
          case 'submodules':
            if (hasRepo) setModal({ kind: 'submodules' })
            break
          case 'optimize':
            if (hasRepo) {
              const repoPath = repoRef.current?.path
              if (repoPath) runOpRef.current(() => window.gitgrove.optimizeRepo(repoPath))
            }
            break
        }
      }),
    [doSync, reloadBranches]
  )

  // Every op that reports progress runs under `busy`; when it ends, so does
  // the fill — one clearing point instead of one per operation.
  useEffect(() => {
    if (!busy) setOpProgress(null)
  }, [busy])

  // Determinate progress pushes for checkout/fetch/pull/push/discard. Only
  // ops this window started count (`busy` is set around them) — the quiet
  // background auto-fetch reports too and must never flash the buttons.
  useEffect(
    () =>
      window.gitgrove.onOpProgress((p) => {
        if (!busyRef.current || p.repoPath !== repoRef.current?.path) return
        const percent = overallPercent(p.kind, p.phase, p.percent)
        if (percent === null) return
        // Phases overlap on the wire (local and remote report concurrently) —
        // never let the fill move backwards.
        setOpProgress((prev) =>
          prev && prev.kind === p.kind
            ? { kind: p.kind, percent: Math.max(prev.percent, percent) }
            : { kind: p.kind, percent }
        )
      }),
    []
  )

  // Credential prompts: queue arrivals, drop expirations, answer via IPC.
  useEffect(
    () =>
      window.gitgrove.onCredentialPrompt((request) => {
        // Queue in arrival order immediately — the OAuth probe is async, and
        // awaiting it before enqueuing could reorder two prompts racing in.
        // Reaching here means no connected account answered silently; resolve
        // whether the host supports one-click browser sign-in and flip the flag
        // on the queued prompt when it does (it both rescues this prompt and
        // connects the account for every future operation).
        setCredentialPrompts((prev) => [...prev, { ...request, oauth: false }])
        if (!request.host) return
        window.gitgrove
          .hasOAuthClient(request.host)
          .then((oauth) => {
            if (!oauth) return
            setCredentialPrompts((prev) =>
              prev.map((p) => (p.requestId === request.requestId ? { ...p, oauth: true } : p))
            )
          })
          .catch(() => {})
      }),
    []
  )
  useEffect(
    () =>
      window.gitgrove.onCredentialDismiss((requestId) =>
        setCredentialPrompts((prev) => prev.filter((p) => p.requestId !== requestId))
      ),
    []
  )
  const respondCredential = useCallback((requestId: string, value: string | null) => {
    setCredentialPrompts((prev) => prev.filter((p) => p.requestId !== requestId))
    window.gitgrove.respondCredential(requestId, value).catch(() => {})
  }, [])

  useEffect(() => {
    return window.gitgrove.onRepoChanged((changedPath) => {
      // Skip watcher-driven refreshes while one of our own ops runs — runOp
      // refreshes once on completion, with the final state.
      if (repoRef.current && changedPath === repoRef.current.path && !busyRef.current) {
        refreshRef.current()
      }
    })
  }, [])

  // Refresh when the window regains focus — the moment external edits (your
  // editor, the terminal) become relevant. Throttled so rapid focus flips
  // don't stack status runs.
  useEffect(() => {
    let last = 0
    const onFocus = () => {
      const now = Date.now()
      if (now - last < 1000) return
      last = now
      if (repoRef.current && !busyRef.current) refreshRef.current()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Quiet background fetch so ahead/behind stays honest without manual checks.
  useEffect(() => {
    if (!repo) return
    const t = setInterval(() => {
      const repoPath = repoRef.current?.path
      if (!repoPath || busyRef.current || syncRef.current?.remotes.length === 0) return
      // `quiet`: a background fetch must never pop the credential dialog.
      window.gitgrove
        .fetch(repoPath, undefined, { quiet: true })
        .then(() => refreshRef.current())
        .catch(() => {})
    }, AUTO_FETCH_INTERVAL)
    return () => clearInterval(t)
  }, [repo])

  // ── About dialog + auto-update ─────────────────────────────────────────────
  useEffect(() => {
    window.gitgrove
      .appInfo()
      .then(setAppInfo)
      .catch(() => {})
  }, [])

  useEffect(() => window.gitgrove.onShowAbout(() => setAboutOpen(true)), [])

  // Open the repository named on the command line / GITGROVE_OPEN_REPO at
  // launch. Main hands it over once (then forgets it), so this fires only for
  // the first mount — a reload drops back to the welcome screen as usual.
  useEffect(() => {
    window.gitgrove
      .initialRepoPath()
      .then((path) => {
        if (path) openRepoByPath(path)
      })
      .catch(() => {})
  }, [openRepoByPath])

  // Probe LFS health once per repo open — cheap (a handful of config reads)
  // and silent for the overwhelming majority of repos that don't use LFS.
  const probeLfsHealth = useCallback((path: string) => {
    let stale = false
    window.gitgrove
      .lfsHealth(path)
      .then((health) => {
        if (!stale) setLfsHealth(health)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])

  const lfsRepoPath = repo?.path
  useEffect(() => {
    setLfsHealth(null)
    setLfsDismissed(false)
    if (!lfsRepoPath) return
    return probeLfsHealth(lfsRepoPath)
  }, [lfsRepoPath, probeLfsHealth])

  const enableLfs = useCallback(async () => {
    const path = repoRef.current?.path
    if (!path) return
    setLfsEnabling(true)
    try {
      await window.gitgrove.lfsEnable(path)
      setLfsHealth(await window.gitgrove.lfsHealth(path))
      setNotice('Git LFS is set up — large files now download and upload correctly.')
    } catch (e) {
      fail(e)
    } finally {
      setLfsEnabling(false)
    }
  }, [fail])

  // What the toolbar shows of the running op: the sync button's fill (only
  // when the progress kind matches the running action) and the branch
  // switcher's "switching to X" fill.
  const syncKind: ProgressOpKind | null =
    syncRunning === null
      ? null
      : syncRunning === 'fetch'
        ? 'fetch'
        : syncRunning.startsWith('pull')
          ? 'pull'
          : 'push'
  const syncProgress = opProgress && opProgress.kind === syncKind ? opProgress.percent : null
  const switching = checkingOut
    ? {
        name: checkingOut,
        percent: opProgress?.kind === 'checkout' ? opProgress.percent : null
      }
    : null

  // The conflicted file focused in Changes, if any — it swaps the diff pane
  // for the dedicated conflict-resolution panel. The conflictedCount guard
  // keeps the (90k-file-capable) list scan off every conflict-free render.
  const conflictFile =
    (repoState?.conflictedCount ?? 0) > 0 && tab === 'changes' && changeSel && changeSelCount === 1
      ? changes.find((f) => f.path === changeSel && f.status === 'conflicted')
      : undefined

  // ── App-level modals ───────────────────────────────────────────────────────
  const repoPath = repo?.path
  const modals = repoPath &&
    modal &&
    modal.kind !== 'settings' &&
    modal.kind !== 'clone' &&
    modal.kind !== 'identity' && (
      <AppModals
        modal={modal}
        repoPath={repoPath}
        branch={branch}
        dirtyCount={changes.length}
        opInFlight={!!repoState?.op}
        busy={modalBusy}
        runModalOp={runModalOp}
        onMerge={performMerge}
        onCreateBranch={performCreateBranch}
        onSwitchBranch={performSwitchBranch}
        onDeleteBranch={deleteBranch}
        onCheckoutCommit={checkoutCommit}
        onOpenRepo={openRepoByPath}
        onError={fail}
        onClose={() => setModal(null)}
      />
    )

  const overlays = (
    <>
      <UpdateBanner
        update={updates.bannerUpdate}
        onInstall={updates.install}
        onDismiss={updates.dismiss}
      />
      {/* Same bottom-right spot as the update banner; updates win when both
          are pending (they're transient, the LFS state isn't going anywhere). */}
      {!updates.bannerUpdate &&
        repoPath &&
        lfsHealth?.usesLfs &&
        (!lfsHealth.filtersConfigured || !lfsHealth.binaryAvailable) &&
        !lfsDismissed && (
          <LfsBanner
            health={lfsHealth}
            enabling={lfsEnabling}
            onEnable={enableLfs}
            onRecheck={() => probeLfsHealth(repoPath)}
            onDismiss={() => setLfsDismissed(true)}
          />
        )}
      {trustPath && (
        <TrustDialog
          path={trustPath}
          busy={trusting}
          onTrust={confirmTrust}
          onCancel={() => setTrustPath(null)}
        />
      )}
      {aboutOpen && (
        <AboutDialog
          info={appInfo}
          update={updates.update}
          onClose={() => setAboutOpen(false)}
          onCheckForUpdates={updates.check}
          onInstall={updates.install}
        />
      )}
      {modal?.kind === 'clone' && (
        <CloneDialog
          onDone={(path) => {
            setModal(null)
            openRepoByPath(path)
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {/* Settings works with or without a repo — connecting an account is
          most valuable right before the first clone. Suppressed while a
          credential prompt is up (same rule as the identity dialog below): the
          prompt holds a live git op and must be the single modal in focus, and
          it carries its own "Sign in with GitHub" path anyway. */}
      {modal?.kind === 'settings' && credentialPrompts.length === 0 && (
        <SettingsDialog
          repoPath={repoPath}
          themePref={themePref}
          onThemePref={setThemePref}
          onClose={() => setModal(null)}
        />
      )}
      {/* Credentials win when both are pending: a credential prompt holds a
          live git process on a 10-minute timeout that must not expire unseen,
          while the identity dialog has no timer and simply reappears (its modal
          state persists) once the prompt is answered. */}
      {modal?.kind === 'identity' && credentialPrompts.length === 0 && (
        <IdentityDialog
          busy={modalBusy}
          initialName={identityPrefill?.name}
          initialEmail={identityPrefill?.email}
          onSubmit={completeIdentitySetup}
          onCancel={cancelIdentitySetup}
        />
      )}
      {credentialPrompts.length > 0 && (
        <CredentialDialog
          // Remount per request so a fresh prompt never inherits typed input.
          key={credentialPrompts[0].requestId}
          request={credentialPrompts[0]}
          oauthAvailable={credentialPrompts[0].oauth}
          onRespond={respondCredential}
        />
      )}
      {modals}
    </>
  )

  // Gate the app until a repo is usable: a brief splash while the (fast) git
  // check runs, a guided setup screen if git is missing (so repo actions that
  // can't possibly work are never offered), then the welcome screen until a
  // repo is opened.
  if (git === null || !git.available || !repo) {
    return (
      <div className="app">
        <Toolbar
          repo={null}
          branch={null}
          branchesLoading={false}
          busy={false}
          refreshing={false}
          themePref={themePref}
          resolvedTheme={theme}
          onOpenRepo={openRepoByPath}
          onPickRepo={pickRepo}
          onCheckout={checkout}
          onRefresh={refresh}
          onThemeChange={setThemePref}
          onAbout={() => setAboutOpen(true)}
        />
        <div className="app__body">
          {git === null ? (
            <div className="welcome">
              <div className="spinner" />
            </div>
          ) : !git.available ? (
            <GitSetup platform={git.platform} checking={gitChecking} onRecheck={recheckGit} />
          ) : (
            <Welcome
              onPickRepo={pickRepo}
              onOpenRepo={openRepoByPath}
              onClone={() => setModal({ kind: 'clone' })}
            />
          )}
        </div>
        {error && <Toast kind="error" message={error} onClose={() => setError(null)} />}
        {overlays}
      </div>
    )
  }

  return (
    <div className="app">
      <Toolbar
        repo={repo}
        branch={branch}
        branchesLoading={branchesLoading}
        busy={busy}
        refreshing={refreshing}
        themePref={themePref}
        resolvedTheme={theme}
        sync={sync}
        syncRunning={syncRunning}
        syncProgress={syncProgress}
        switching={switching}
        onSyncAction={doSync}
        onBranchAction={onBranchAction}
        onBranchesOpen={reloadBranches}
        onOpenRepo={openRepoByPath}
        onPickRepo={pickRepo}
        onCheckout={checkout}
        onRefresh={refresh}
        onThemeChange={setThemePref}
        onAbout={() => setAboutOpen(true)}
      />
      <div
        className="app__body"
        ref={bodyRef}
        style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="sidebar">
          <div className="sidebar__tabs">
            <button
              className={`tab${tab === 'changes' ? ' is-active' : ''}`}
              onClick={() => switchTab('changes')}
            >
              <Icon.Changes size={15} /> Changes
              {changes.length > 0 && <span className="tab__count">{changes.length}</span>}
            </button>
            <button
              className={`tab${tab === 'history' ? ' is-active' : ''}`}
              onClick={() => switchTab('history')}
            >
              <Icon.History size={15} /> History
            </button>
          </div>
          <div className="sidebar__body">
            {/* Both panes stay mounted — only the active one is shown — so a
                tab switch never discards the composer draft, the file filters
                or the working-list selection (all component-local state). */}
            <div className={`sidebar__pane${tab === 'changes' ? '' : ' sidebar__pane--hidden'}`}>
              <ChangesView
                repoPath={repo.path}
                branch={
                  branch?.detached
                    ? `detached @ ${branch.current.slice(0, 7)}`
                    : (branch?.current ?? '')
                }
                changes={changes}
                loading={changesLoading}
                busy={busy}
                repoState={repoState}
                stashes={stashes}
                selectedPath={changeSel}
                onSelectFile={(path) => selectWorkingFile(path)}
                onFileSelectionChange={setChangeSelCount}
                selections={selections}
                onToggleFile={toggleFileIncluded}
                onSetAllIncluded={setAllIncluded}
                commitSize={commitSize}
                discardProgress={opProgress?.kind === 'discard' ? opProgress.percent : null}
                theme={theme}
                runOp={runOp}
                onError={fail}
                onCommit={doCommit}
                onStash={doStash}
                onOpenFileHistory={openFileHistory}
              />
            </div>
            <div className={`sidebar__pane${tab === 'history' ? '' : ' sidebar__pane--hidden'}`}>
              <HistoryView
                repoPath={repo.path}
                commits={commits}
                loading={commitsLoading}
                hasMore={logHasMore}
                loadingMore={commitsLoadingMore}
                onLoadMore={loadMoreLog}
                selectedCommit={selectedCommit}
                onSelectCommit={selectCommit}
                commitFiles={commitFiles}
                commitFilesLoading={commitFilesLoading}
                selectedFilePath={commitSelPath}
                onSelectFile={(p) => selectedCommit && selectCommitFile(p, selectedCommit.hash)}
                onFileSelectionChange={setCommitSelCount}
                commitMenuFor={commitMenuFor}
                onOpenFileHistory={openFileHistory}
              />
            </div>
          </div>
        </aside>

        <Resizer
          orientation="x"
          size={sidebarWidth}
          min={220}
          max={620}
          onPreview={(w) => bodyRef.current?.style.setProperty('--sidebar-w', `${w}px`)}
          onCommit={setSidebarWidth}
        />

        <div className="workspace">
          {conflictFile ? (
            <ConflictPanel
              key={conflictFile.path}
              repoPath={repo.path}
              file={conflictFile}
              ours={branch?.current ?? 'current branch'}
              theirs={mergeSourceFromDetail(repoState?.detail)}
              theme={theme}
              busy={busy}
              runOp={runOp}
              onError={fail}
            />
          ) : (
            <>
              {tab === 'history' && selectedCommit && (
                <CommitSummary
                  key={selectedCommit.hash}
                  commit={selectedCommit}
                  files={commitFiles}
                  filesLoading={commitFilesLoading}
                />
              )}
              <DiffViewer
                diff={diff}
                loading={diffLoading}
                mode={diffMode}
                wrap={diffWrap}
                theme={theme}
                selectedCount={tab === 'changes' ? changeSelCount : commitSelCount}
                onModeChange={setDiffMode}
                onWrapChange={setDiffWrap}
                selectionActions={
                  tab === 'changes' && changeSel
                    ? {
                        selection: selections.get(changeSel) ?? 'all',
                        onChange: (selected, total) => setHunkSelection(changeSel, selected, total),
                        onDiscard: discardHunk,
                        busy
                      }
                    : undefined
                }
              />
            </>
          )}
        </div>
      </div>

      {fileHistory && (
        <FileHistoryOverlay
          key={`${fileHistory.path}:${fileHistory.baseRef ?? 'wt'}`}
          repoPath={repo.path}
          path={fileHistory.path}
          mode={fileHistory.mode}
          baseRef={fileHistory.baseRef}
          theme={theme}
          onClose={() => setFileHistory(null)}
        />
      )}
      {error && <Toast kind="error" message={error} onClose={() => setError(null)} />}
      {notice && !error && (
        <Toast kind="success" message={notice} onClose={() => setNotice(null)} />
      )}
      {overlays}
      <TooltipLayer />
    </div>
  )
}
