import type {
  AppInfo,
  BranchChangesAction,
  BranchInfo,
  ChangedFile,
  CheckoutOutcome,
  Commit,
  IdentityScope,
  MergeKind,
  MergeOutcome,
  RepoHostInfo,
  RepoOpenResult,
  RepoSnapshot,
  RepoState,
  RepoSummary,
  StashEntry,
  SyncStatus,
  UndoSnapshot
} from '@shared/types'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { AboutDialog } from './components/app/AboutDialog'
import { AppModals, type Modal } from './components/app/AppModals'
import { CloneDialog } from './components/app/CloneDialog'
import type { CreateBranchRequest } from './components/app/CreateBranchDialog'
import { CredentialDialog } from './components/app/CredentialDialog'
import { ErrorDialog } from './components/app/ErrorDialog'
import { GitSetup } from './components/app/GitSetup'
import { IdentityDialog } from './components/app/IdentityDialog'
import { LfsBanner } from './components/app/LfsBanner'
import { MissingRepo } from './components/app/MissingRepo'
import { TrustDialog } from './components/app/TrustDialog'
import { UpdateBanner } from './components/app/UpdateBanner'
import { Welcome } from './components/app/Welcome'
import { ChangesView } from './components/changes/ChangesView'
import type { ComposerDraft } from './components/changes/CommitComposer'
import { ConflictPanel } from './components/changes/ConflictPanel'
import { useCommitSelections } from './components/changes/useCommitSelections'
import type { ContextMenuItem } from './components/common/ContextMenu'
import { type DiffMode, DiffViewer } from './components/common/DiffViewer'
import { Resizer } from './components/common/Resizer'
import { Toast } from './components/common/Toast'
import { TooltipLayer } from './components/common/TooltipLayer'
import { GraphDetailPane } from './components/graph/GraphDetailPane'
import { GraphView } from './components/graph/GraphView'
import { useBranchRange } from './components/graph/useBranchRange'
import { CommitSummary } from './components/history/CommitSummary'
import { commitMenuItems } from './components/history/commitMenuItems'
import { FileHistoryOverlay, type FileHistoryTarget } from './components/history/FileHistoryOverlay'
import { HistoryView } from './components/history/HistoryView'
import { useCommitDetail } from './components/history/useCommitDetail'
import { useCommitLog } from './components/history/useCommitLog'
import { SettingsDialog } from './components/settings/SettingsDialog'
import type { BranchAction } from './components/toolbar/BranchSwitcher'
import { Toolbar } from './components/toolbar/Toolbar'
import { useSyncActions } from './components/toolbar/useSyncActions'
import { buildCommitSelection, buildStashSelection } from './lib/commit-selection'
import { Icon } from './lib/icons'
import { mergeSourceFromDetail } from './lib/merge'
import { usePersistentState } from './lib/persist'
import { createRepoGeneration } from './lib/repoGeneration'
import { useTheme } from './lib/theme'
import { useCredentialPrompts } from './lib/useCredentialPrompts'
import { useDiffLoader } from './lib/useDiffLoader'
import { useGitAvailability } from './lib/useGitAvailability'
import { useLfs } from './lib/useLfs'
import { useOpProgress } from './lib/useOpProgress'
import { useOsIntegration } from './lib/useOsIntegration'
import { usePullRequests } from './lib/usePullRequests'
import { type MissingRepoInfo, useRepoRecovery } from './lib/useRepoRecovery'
import { useUpdateBanner } from './lib/useUpdateBanner'

type Tab = 'changes' | 'history' | 'graph'

export function App() {
  const [repo, setRepo] = useState<RepoSummary | null>(null)
  // The repo's web URL + whether its host is GitHub, for view-on-web / PR links.
  const [hostInfo, setHostInfo] = useState<RepoHostInfo | null>(null)
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
  // when git is missing (see the render gate below and useGitAvailability).
  const { git, gitChecking, recheckGit } = useGitAvailability()

  // Path of a folder git flagged as untrusted ("dubious ownership"); set to show
  // the trust prompt, with `trusting` true while persisting the exception.
  const [trustPath, setTrustPath] = useState<string | null>(null)
  const [trusting, setTrusting] = useState(false)

  // A repo whose folder is gone — set to swap the workspace for the recovery
  // screen (Locate / Clone Again / Remove). The recovery actions + the
  // "Check again" busy flag live in useRepoRecovery (wired up below).
  const [missingRepo, setMissingRepo] = useState<MissingRepoInfo | null>(null)

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
  // The one-step undo for the last operation (drives the Changes undo banner),
  // and a message to drop into the composer after undoing a commit.
  const [undo, setUndo] = useState<UndoSnapshot | null>(null)
  const [composerDraft, setComposerDraft] = useState<ComposerDraft | null>(null)
  // Branch a checkout is switching to, for the switcher's progress display.
  const [checkingOut, setCheckingOut] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal | null>(null)
  const [modalBusy, setModalBusy] = useState(false)

  // Credential prompts pushed from main while a network op waits on auth — see
  // useCredentialPrompts.
  const { credentialPrompts, respondCredential } = useCredentialPrompts()

  const [sidebarWidth, setSidebarWidth] = usePersistentState('gg.sidebarWidth', 340)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [diffMode, setDiffMode] = usePersistentState<DiffMode>('gg.diffMode', 'split')
  const [diffWrap, setDiffWrap] = usePersistentState('gg.diffWrap', false)
  // The Graph tab's diff pane height (diagram above, diff below).
  const [graphDiffHeight, setGraphDiffHeight] = usePersistentState('gg.graphDiffHeight', 320)
  const graphDiffRef = useRef<HTMLDivElement>(null)
  // Bumped whenever history may have changed (refresh, checkout, branch ops);
  // the Graph tab refetches when visible and marks itself stale otherwise.
  const [graphNonce, setGraphNonce] = useState(0)
  const bumpGraph = useCallback(() => setGraphNonce((n) => n + 1), [])
  const { pref: themePref, resolved: theme, setPref: setThemePref } = useTheme()

  const repoRef = useRef<RepoSummary | null>(null)
  repoRef.current = repo
  const hostInfoRef = useRef<RepoHostInfo | null>(null)
  hostInfoRef.current = hostInfo
  // Refs so the filesystem-driven refresh can read the latest view without
  // being re-created (which would re-subscribe the watcher).
  const tabRef = useRef<Tab>(tab)
  tabRef.current = tab
  const changeSelRef = useRef<string | null>(changeSel)
  changeSelRef.current = changeSel
  const changesRef = useRef<ChangedFile[]>(changes)
  changesRef.current = changes
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
  // Lets the menu's "Undo Last Action" no-op silently when there's nothing to
  // undo (the banner button only shows when there is).
  const undoRef = useRef<UndoSnapshot | null>(undo)
  undoRef.current = undo
  const branchesLoadingRef = useRef(false)
  // Bumped on every repo switch; async loaders capture it before they await and
  // bail on return if it moved, so a slow load from the previous repo never
  // paints the newly-opened one — see createRepoGeneration.
  const repoGenRef = useRef(createRepoGeneration())
  // Refresh coalescing: one in flight at a time; triggers that arrive while it
  // runs collapse into a single trailing run (watcher + focus + post-op can
  // otherwise stack three status passes on big repos).
  const refreshInFlight = useRef(false)
  const refreshQueued = useRef(false)

  const fail = useCallback((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e)
    setError(message)
  }, [])

  // A git command failed: if the open repo's folder has vanished, drop into the
  // recovery screen instead of a cryptic error toast; otherwise surface it
  // normally. Used by the refresh/open paths that touch the working tree.
  const failOrRecover = useCallback(
    async (e: unknown) => {
      const path = repoRef.current?.path
      if (path) {
        const res = await window.gitgrove.openRepo(path).catch(() => null)
        if (res && !res.ok && res.reason === 'missing') {
          setRepo(null)
          setMissingRepo({ path: res.path, name: res.name, remoteUrl: res.remoteUrl })
          return
        }
      }
      fail(e)
    },
    [fail]
  )

  const updates = useUpdateBanner(aboutOpen, fail)

  const getRepoPath = useCallback(() => repoRef.current?.path, [])
  const { diff, diffRef, diffLoading, loadWorkingDiff, loadCommitDiff, loadRangeDiff, clearDiff } =
    useDiffLoader(getRepoPath, fail)

  // Determinate progress of the op this window started — see useOpProgress.
  const opProgress = useOpProgress(busy, busyRef, getRepoPath)

  // The GitHub slice: unpushed set, PR badges, the create-PR banner — see
  // usePullRequests.
  const { unpushedRef, prByBranch, createPrUrl, loadGithubData, fetchBranchPrs, resetGithub } =
    usePullRequests({
      getRepoPath,
      repo,
      hostInfo,
      branch,
      sync
    })

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
    setUndo(snap.undo)
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
    async (repoPath: string): Promise<ChangedFile[] | null> => {
      const generation = repoGenRef.current.current()
      const snap = JSON.parse(await window.gitgrove.snapshot(repoPath)) as RepoSnapshot
      // A repo switch landed while the (potentially slow) snapshot was fetching:
      // this one belongs to the previous repo, so drop it rather than paint the
      // new repo's sidebar with the old changes/branch/sync/stashes. `null`
      // signals "stale" so callers skip their follow-up selection too.
      if (!repoGenRef.current.isCurrent(generation)) return null
      return applySnapshot(snap)
    },
    [applySnapshot]
  )

  const loadBranches = useCallback(async (repoPath: string) => {
    if (branchesLoadingRef.current) return null
    branchesLoadingRef.current = true
    setBranchesLoading(true)
    const generation = repoGenRef.current.current()
    try {
      const info = await window.gitgrove.branches(repoPath)
      // Enumeration is the slowest sidebar load on big repos; if the repo was
      // switched out from under it, bail without painting the previous repo's
      // branch list (and current branch) onto the new one.
      if (!repoGenRef.current.isCurrent(generation)) return null
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

  // The History tab's commit log — paged fetch, infinite-scroll paging, and the
  // debounced server-side filter — see useCommitLog. The orchestrators below
  // drive it through loadLog / resetLog / markLogStale / clearLogSearch.
  const {
    commits,
    commitsLoading,
    logHasMore,
    commitsLoadingMore,
    logLoaded,
    logSearch,
    logSearching,
    revealingCommit,
    logLoadedRef,
    commitsRef,
    logSearchRef,
    loadLog,
    loadMoreLog,
    onLogSearchChange,
    clearLogSearch,
    markLogStale,
    resetLog,
    setRevealingCommit
  } = useCommitLog(getRepoPath, fail)

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

  // The selected History commit and its file list — see useCommitDetail.
  const {
    selectedCommit,
    commitFiles,
    commitFilesLoading,
    commitSelPath,
    commitSelCount,
    setCommitSelCount,
    selectCommit,
    selectCommitFile,
    resetDetail
  } = useCommitDetail({ getRepoPath, fail, loadCommitDiff, diffRef, clearDiff })

  // The Graph tab's branch-changes selection (label click → base..tip diff) —
  // see useBranchRange. Mutually exclusive with the commit selection.
  const {
    range: branchRange,
    rangeFiles,
    rangeFilesLoading,
    rangeSelPath,
    openRange,
    selectRangeFile,
    resetRange
  } = useBranchRange({ getRepoPath, fail, loadRangeDiff, clearDiff })

  /** Select a commit, dismissing any open branch-changes view. */
  const selectCommitOnly = useCallback(
    (commit: Commit) => {
      resetRange()
      selectCommit(commit)
    },
    [resetRange, selectCommit]
  )

  /**
   * Reveal a commit in the History tab from elsewhere (the blame gutter's commit
   * link): close any overlay, switch to History, and select the commit. If it
   * hasn't been paged in yet — an old commit past the loaded window — ask git
   * for its index and page the log deep enough to include it first. HistoryView
   * then scrolls the selected commit into view. A no-op for commits that aren't
   * on HEAD's history (nothing to select).
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: logSearchRef/logLoadedRef/commitsRef are refs read for their live values, not triggers.
  const revealCommit = useCallback(
    async (hash: string) => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return
      setFileHistory(null)
      setTab('history')
      // A revealed commit is located in the full HEAD history; an active filter
      // would likely exclude it, so clear the filter (and any pending reload)
      // before paging. While a filter was set the loaded list is the *filtered*
      // one, so the loaded-list fast paths below can't be trusted — force a fresh
      // unfiltered load instead.
      const wasFiltered = logSearchRef.current.trim() !== ''
      clearLogSearch()
      // Fast path: already paged in (and unfiltered) — select it straight away.
      const loaded =
        !wasFiltered && logLoadedRef.current
          ? commitsRef.current.find((c) => c.hash === hash)
          : null
      if (loaded) {
        selectCommitOnly(loaded)
        return
      }
      // Otherwise we may have to page the log deep to reach it (a super-old
      // commit can take seconds). Flag it *before* the async index lookup and
      // deep load so the History tab's blocking overlay appears the instant we
      // switch tabs — not after a stale/partial list has flashed in.
      setRevealingCommit(hash)
      try {
        let list =
          !wasFiltered && logLoadedRef.current
            ? commitsRef.current
            : await loadLog(repoPath).catch(() => [])
        if (!list.some((c) => c.hash === hash)) {
          const index = await window.gitgrove.commitIndex(repoPath, hash).catch(() => -1)
          if (index < 0) return
          list = await loadLog(repoPath, undefined, { minCount: index + 1 }).catch(() => list)
        }
        const target = list.find((c) => c.hash === hash)
        if (target) selectCommitOnly(target)
      } finally {
        setRevealingCommit(null)
      }
    },
    [loadLog, selectCommitOnly, clearLogSearch, setRevealingCommit]
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
        // History and Graph share the commit selection; re-point the diff
        // pane at it. The graph's own data loads inside GraphView on demand,
        // and its branch-changes selection wins there when open.
        if (next === 'history') {
          // First visit to History: fetch the log on demand.
          const repoPath = repoRef.current?.path
          if (repoPath && !logLoaded && !commitsLoading) loadLog(repoPath).catch(fail)
        }
        if (next === 'graph' && branchRange) {
          if (rangeSelPath) selectRangeFile(rangeSelPath, { force: true })
          else clearDiff()
        } else if (selectedCommit && commitSelPath) {
          selectCommitFile(commitSelPath, selectedCommit.hash, undefined, { force: true })
        } else clearDiff()
      }
    },
    [
      changeSel,
      commitSelPath,
      selectedCommit,
      branchRange,
      rangeSelPath,
      logLoaded,
      commitsLoading,
      loadLog,
      selectWorkingFile,
      selectCommitFile,
      selectRangeFile,
      clearDiff,
      fail
    ]
  )

  // ── Refresh: pulls every panel up to date (watcher + post-op) ─────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: logLoadedRef is a ref read for its live value, not a trigger.
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
      if (logLoadedRef.current && !refreshLog) markLogStale()
      // The Graph tab follows the same rule on its own: a nonce bump refetches
      // while it's visible and marks it stale otherwise.
      bumpGraph()
      const [files] = await Promise.all([
        loadSnapshot(repoPath),
        refreshLog ? loadLog(repoPath, undefined, { keepCount: true }) : Promise.resolve(null),
        // A commit/push/fetch may have changed which commits are on the remote
        // and which branches have PRs.
        hostInfoRef.current?.provider === 'github' ? loadGithubData(repoPath) : Promise.resolve()
      ])
      // A repo switch landed mid-refresh: the snapshot is stale, so don't touch
      // the (now different) repo's selection or diff.
      if (!files) return
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
      await failOrRecover(e)
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
      if (refreshQueued.current) {
        refreshQueued.current = false
        refreshRef.current()
      }
    }
  }, [
    loadSnapshot,
    loadLog,
    loadWorkingDiff,
    autoSelect,
    failOrRecover,
    loadGithubData,
    markLogStale,
    bumpGraph
  ])

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
  const runOpRef = useRef(runOp)
  runOpRef.current = runOp

  // The commit selection (pure renderer state, zero git): the checkbox map plus
  // the file/master/hunk toggles, discard-hunk, and the next commit's on-disk
  // size — see useCommitSelections.
  const {
    selections,
    setSelections,
    toggleFileIncluded,
    setAllIncluded,
    setFileSelection,
    discardHunk,
    commitSize
  } = useCommitSelections({ changes, changesRef, getRepoPath, runOpRef })

  // The sync slice: fetch/pull/push runner, the running-button flag, and its
  // determinate fill — see useSyncActions.
  const { doSync, syncRunning, syncProgress } = useSyncActions({
    getRepoPath,
    runOp,
    syncRef,
    branchRef,
    opProgress
  })

  /**
   * Undo the last history-changing operation. Like runOp (serialized behind
   * `busy`, refreshed on completion, errors → toast) but it keeps the result so
   * an undone commit's message can flow back into the composer. No-ops when
   * there's nothing to undo, so the menu item is harmless when the banner is hidden.
   */
  const doUndo = useCallback(async () => {
    const repoPath = repoRef.current?.path
    if (!repoPath || busyRef.current || !undoRef.current) return
    setBusy(true)
    try {
      const result = await window.gitgrove.undo(repoPath)
      await refreshRef.current()
      if (result.message !== undefined) {
        const [first, ...rest] = result.message.split('\n')
        setComposerDraft({
          summary: first ?? '',
          description: rest.join('\n').replace(/^\n+/, ''),
          nonce: Date.now()
        })
      }
      setNotice(result.notice)
    } catch (e) {
      fail(e)
      await refreshRef.current().catch(() => {})
    } finally {
      setBusy(false)
    }
  }, [fail])
  const doUndoRef = useRef(doUndo)
  doUndoRef.current = doUndo

  // ── Repository lifecycle ───────────────────────────────────────────────────
  const applyRepo = useCallback(
    async (summary: RepoSummary) => {
      // `summary` carries only the current branch name (a cheap open); the full
      // branch list and status are fetched here so the repo switch itself is
      // instant and each panel shows its own progress.
      setRepo(summary)
      // Mark this as the active repo: any load still in flight for the previous
      // one now reads as stale and won't paint this repo's sidebar.
      const generation = repoGenRef.current.next()
      setMissingRepo(null)
      // Resolve the host (web URL + GitHub-ness) for view-on-web / PR links;
      // cheap and independent, so it fills in on its own without gating the UI.
      // On a GitHub host, also load the unpushed set and open PRs.
      setHostInfo(null)
      resetGithub()
      window.gitgrove
        .repoHostInfo(summary.path)
        .then((info) => {
          setHostInfo(info)
          if (info.provider === 'github') loadGithubData(summary.path)
        })
        .catch(() => setHostInfo(null))
      setBranch(summary.branch)
      setChanges([])
      resetLog()
      clearLogSearch()
      resetDetail()
      resetRange()
      setChangeSel(null)
      setSelections(new Map())
      clearDiff()
      setRepoState(null)
      setSync(null)
      setStashes([])
      setUndo(null)
      setComposerDraft(null)
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
        // `null` = a switch superseded this load; leave the spinner and the
        // selection to the repo that's now active rather than clobbering them.
        if (files && files.length > 0) autoSelect(files, tabRef.current === 'changes')
      } catch (e) {
        await failOrRecover(e)
      } finally {
        if (repoGenRef.current.isCurrent(generation)) setChangesLoading(false)
      }
    },
    [
      loadSnapshot,
      loadBranches,
      autoSelect,
      clearDiff,
      fail,
      failOrRecover,
      loadGithubData,
      resetGithub,
      resetLog,
      clearLogSearch,
      resetDetail,
      resetRange,
      setSelections
    ]
  )

  // Route an open outcome: success applies the repo, an untrusted folder opens
  // the trust prompt, a vanished folder opens the recovery screen, and a
  // non-repo surfaces the familiar error.
  const handleOpen = useCallback(
    (res: RepoOpenResult) => {
      if (res.ok) applyRepo(res.summary)
      else if (res.reason === 'untrusted') setTrustPath(res.path)
      else if (res.reason === 'missing') {
        setRepo(null)
        setMissingRepo({ path: res.path, name: res.name, remoteUrl: res.remoteUrl })
      } else setError('The selected folder is not a git repository.')
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

  // Missing-repo recovery (Locate / Clone Again / Remove / Check again) — see
  // useRepoRecovery.
  const { recovering, recoverCheckAgain, recoverLocate, recoverRemove, recoverCloneAgain } =
    useRepoRecovery({ missingRepo, setMissingRepo, handleOpen, fail, openModal: setModal })

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
        resetDetail()
        resetRange()
        setChangeSel(null)
        setSelections(new Map())
        resetLog()
        clearDiff()
        // This path bypasses refresh(), so nudge the graph itself.
        bumpGraph()
        // The new branch invalidates the log; reload it now only if History is
        // showing, otherwise leave it for the next time the tab is opened.
        if (tabRef.current === 'history') loadLog(repoPath).catch(fail)
        const files = await loadSnapshot(repoPath)
        if (files && files.length > 0) autoSelect(files, tabRef.current === 'changes')
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
    [
      loadSnapshot,
      loadLog,
      autoSelect,
      clearDiff,
      fail,
      resetLog,
      resetDetail,
      resetRange,
      setSelections,
      bumpGraph
    ]
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
    [runOp, selections, setSelections]
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
    [runOp, selections, setSelections]
  )

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
          markLogStale()
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
    [loadLog, fail, markLogStale]
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: unpushedRef is a ref read for its live value (the unpushed-commit set), not a trigger.
  const commitMenuFor = useCallback(
    (commit: Commit): ContextMenuItem[] => {
      const repoPath = repoRef.current?.path
      if (!repoPath) return []
      const gg = window.gitgrove
      const host = hostInfoRef.current
      const webUrl = host?.provider === 'github' ? host.webUrl : null
      return commitMenuItems(
        commit,
        commits,
        branchRef.current?.current ?? 'current branch',
        {
          checkoutCommit: (c) =>
            setModal({ kind: 'checkout-commit', hash: c.hash, shortHash: c.shortHash }),
          newBranchAt: (c) =>
            setModal({ kind: 'new-branch', from: c.hash, fromLabel: c.shortHash }),
          createTagAt: (c) =>
            setModal({ kind: 'create-tag', hash: c.hash, shortHash: c.shortHash }),
          cherryPick: (c) => runOpRef.current(() => gg.cherryPick(repoPath, c.hash)),
          revert: (c) => setModal({ kind: 'revert', hash: c.hash, shortHash: c.shortHash }),
          interactiveRebase: (chain, base) => setModal({ kind: 'irebase', commits: chain, base }),
          reset: (c, mode) => runOpRef.current(() => gg.reset(repoPath, c.hash, mode)),
          confirmHardReset: (c) =>
            setModal({ kind: 'reset', hash: c.hash, shortHash: c.shortHash, mode: 'hard' }),
          undoLast: () => doUndoRef.current()
        },
        webUrl,
        unpushedRef.current.has(commit.hash),
        // No undo entry mid-operation — the op owns the working tree (matches the
        // Changes banner, which also hides while an op is in flight).
        repoStateRef.current?.op ? null : undoRef.current
      )
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
        markLogStale()
        if (tabRef.current === 'history') loadLog(repoPath).catch(fail)
      }
    },
    [loadLog, fail, markLogStale]
  )

  // ── OS integration: menu commands + filesystem change notifications ────────
  // Native menu commands, the watcher refresh, the focus refresh and the quiet
  // background fetch — see useOsIntegration.
  useOsIntegration({
    repo,
    repoRef,
    busyRef,
    syncRef,
    refreshRef,
    doUndoRef,
    runOpRef,
    pickRepo,
    doSync,
    reloadBranches,
    openModal: setModal
  })

  // ── About dialog + auto-update ─────────────────────────────────────────────
  useEffect(() => {
    window.gitgrove
      .appInfo()
      .then(setAppInfo)
      .catch(() => {})
  }, [])

  useEffect(() => window.gitgrove.onShowAbout(() => setAboutOpen(true)), [])

  // Window title = the open repo, so multiple GitGrove windows stay tellable
  // apart in the Window menu, Alt-Tab/Mission Control and the taskbar. (The
  // in-window title bar is custom, so this never paints inside the app.)
  useEffect(() => {
    document.title = repo ? `${repo.name} — GitGrove` : 'GitGrove'
  }, [repo])

  // Open the repository this window was created for: "Open in New Window", a
  // second-instance `--repo`, or (first window) the command line /
  // GITGROVE_OPEN_REPO. Main hands it over once (then forgets it), so this
  // fires only for the first mount — a reload drops back to the welcome
  // screen as usual.
  useEffect(() => {
    window.gitgrove
      .initialRepoPath()
      .then((path) => {
        if (path) openRepoByPath(path)
      })
      .catch(() => {})
  }, [openRepoByPath])

  // A dock-menu / Jump List recent aimed at this window (it was idling on the
  // welcome screen, so main reused it instead of opening a sibling window).
  useEffect(
    () => window.gitgrove.onOpenRepoRequest((path) => openRepoByPath(path)),
    [openRepoByPath]
  )

  // Git LFS health of the open repo + the one-click enable — see useLfs.
  const { lfsHealth, lfsDismissed, dismissLfs, lfsEnabling, enableLfs, probeLfsHealth } = useLfs(
    repo?.path,
    getRepoPath,
    fail,
    setNotice
  )

  // The branch switcher's "switching to X" fill (the sync button's fill lives
  // in useSyncActions; this one keys off the checkout the branch-op path owns).
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
            onDismiss={dismissLfs}
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
          initial={modal.initial}
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
          initialSection={modal.section}
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
          onClone={() => setModal({ kind: 'clone' })}
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
          ) : missingRepo ? (
            <MissingRepo
              name={missingRepo.name}
              path={missingRepo.path}
              remoteUrl={missingRepo.remoteUrl}
              checking={recovering}
              onLocate={recoverLocate}
              onCloneAgain={recoverCloneAgain}
              onRemove={recoverRemove}
              onCheckAgain={recoverCheckAgain}
            />
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
        githubWebUrl={hostInfo?.provider === 'github' ? hostInfo.webUrl : null}
        prByBranch={prByBranch}
        onNeedPrs={(branches, opts) => fetchBranchPrs(repo.path, branches, opts)}
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
        onClone={() => setModal({ kind: 'clone' })}
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
            <button
              className={`tab${tab === 'graph' ? ' is-active' : ''}`}
              onClick={() => switchTab('graph')}
            >
              <Icon.Branch size={15} /> Graph
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
                createPrUrl={createPrUrl}
                undo={undo}
                onUndo={doUndo}
                composerDraft={composerDraft}
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
                onSetupAi={() => setModal({ kind: 'settings', section: 'ai' })}
              />
            </div>
            <div className={`sidebar__pane${tab === 'history' ? '' : ' sidebar__pane--hidden'}`}>
              <HistoryView
                repoPath={repo.path}
                commits={commits}
                loading={commitsLoading}
                search={logSearch}
                searchLoading={logSearching}
                onSearchChange={onLogSearchChange}
                hasMore={logHasMore}
                loadingMore={commitsLoadingMore}
                onLoadMore={loadMoreLog}
                revealing={revealingCommit}
                selectedCommit={selectedCommit}
                onSelectCommit={selectCommitOnly}
                commitFiles={commitFiles}
                commitFilesLoading={commitFilesLoading}
                selectedFilePath={commitSelPath}
                onSelectFile={(p) => selectedCommit && selectCommitFile(p, selectedCommit.hash)}
                onFileSelectionChange={setCommitSelCount}
                commitMenuFor={commitMenuFor}
                onOpenFileHistory={openFileHistory}
              />
            </div>
            <div className={`sidebar__pane${tab === 'graph' ? '' : ' sidebar__pane--hidden'}`}>
              <GraphDetailPane
                repoPath={repo.path}
                commit={selectedCommit}
                range={branchRange}
                files={branchRange ? rangeFiles : commitFiles}
                filesLoading={branchRange ? rangeFilesLoading : commitFilesLoading}
                selectedFilePath={branchRange ? rangeSelPath : commitSelPath}
                onSelectFile={(p) => {
                  if (branchRange) selectRangeFile(p)
                  else if (selectedCommit) selectCommitFile(p, selectedCommit.hash)
                }}
                onFileSelectionChange={setCommitSelCount}
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
          {/* Kept mounted (hidden) across tab switches — and while the
              conflict panel takes over — so the diagram's pan/zoom and filter
              state survive; same policy as the sidebar panes. Its diff pane
              mounts only while Graph shows. Keyed by repo: a repo switch gets
              a fresh view framed on its own HEAD. */}
          <div
            key={repo.path}
            className={`graph-workspace${tab === 'graph' ? '' : ' graph-workspace--hidden'}`}
          >
            <GraphView
              repoPath={repo.path}
              active={tab === 'graph'}
              refreshNonce={graphNonce}
              theme={theme}
              branch={branch}
              remotes={sync?.remotes ?? []}
              changesCount={changes.length}
              selectedCommit={selectedCommit}
              onSelectCommit={(commit) => {
                if (commit) {
                  selectCommitOnly(commit)
                } else {
                  resetDetail()
                  resetRange()
                  clearDiff()
                }
              }}
              selectedBranchTip={branchRange?.head ?? null}
              onSelectBranch={(row) => {
                resetDetail()
                clearDiff()
                openRange({ name: row.name, base: row.baseHash, head: row.tipHash })
              }}
              commitMenuFor={commitMenuFor}
              onCheckoutBranch={checkout}
              onBranchAction={onBranchAction}
              onOpenChanges={() => switchTab('changes')}
              onError={fail}
            />
            {tab === 'graph' && (selectedCommit || branchRange) && (
              <>
                <Resizer
                  orientation="y"
                  invert
                  size={graphDiffHeight}
                  min={160}
                  max={800}
                  onPreview={(h) => graphDiffRef.current?.style.setProperty('height', `${h}px`)}
                  onCommit={setGraphDiffHeight}
                />
                <div
                  className="graph-workspace__diff"
                  ref={graphDiffRef}
                  style={{ height: graphDiffHeight }}
                >
                  <DiffViewer
                    diff={diff}
                    loading={diffLoading}
                    mode={diffMode}
                    wrap={diffWrap}
                    theme={theme}
                    selectedCount={commitSelCount}
                    onModeChange={setDiffMode}
                    onWrapChange={setDiffWrap}
                  />
                </div>
              </>
            )}
          </div>
          {tab !== 'graph' &&
            (conflictFile ? (
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
                          onChange: (sel) => setFileSelection(changeSel, sel),
                          onDiscard: discardHunk,
                          busy
                        }
                      : undefined
                  }
                />
              </>
            ))}
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
          onRevealCommit={revealCommit}
        />
      )}
      {error && <ErrorDialog message={error} info={appInfo} onClose={() => setError(null)} />}
      {notice && !error && (
        <Toast kind="success" message={notice} onClose={() => setNotice(null)} />
      )}
      {overlays}
      <TooltipLayer />
    </div>
  )
}
