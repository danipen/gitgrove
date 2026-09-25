// Wiring from OS / filesystem events to app actions: the native menu commands,
// the watcher-driven refresh, the focus refresh, and the quiet background fetch.
//
// Every effect here reads the app's live refs (repo/busy/sync) and the stable
// action refs (refresh) rather than depending on them, so the
// subscriptions install once and never tear down — the same live-ref pattern
// the codebase uses for diffRef. Hence the biome-ignore directives below.

import type { AppCommandId } from '@shared/commands'
import type { RepoSummary, SyncStatus } from '@shared/types'
import { type RefObject, useEffect } from 'react'

/** Background fetch cadence (ms) — quiet, skipped while an op runs. */
const AUTO_FETCH_INTERVAL = 10 * 60 * 1000

interface Params {
  repo: RepoSummary | null
  repoRef: RefObject<RepoSummary | null>
  busyRef: RefObject<boolean>
  syncRef: RefObject<SyncStatus | null>
  refreshRef: RefObject<() => Promise<void>>
  /** The shared command dispatcher (useAppCommands) — stable identity. */
  runCommand: (id: AppCommandId) => void
}

export function useOsIntegration({
  repo,
  repoRef,
  busyRef,
  syncRef,
  refreshRef,
  runCommand
}: Params): void {
  useEffect(() => window.gitgrove.onMenuCommand(runCommand), [runCommand])

  // biome-ignore lint/correctness/useExhaustiveDependencies: repoRef/busyRef/refreshRef are refs read for their live values, not triggers.
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoRef/busyRef/refreshRef are refs read for their live values, not triggers.
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoRef/busyRef/syncRef/refreshRef are refs read for their live values; the effect keys on `repo`.
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
}
