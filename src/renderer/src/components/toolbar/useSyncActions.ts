// The sync slice: the fetch/pull/push/publish action runner, the `syncRunning`
// flag that lights up the running button, and the determinate fill mapped onto
// it (only while the in-flight op's progress kind matches the running action).
// `switching` — the branch switcher's fill — stays in App: it keys off the
// checkout state the branch-op path owns, not sync.

import type { BranchInfo, ProgressOpKind, SyncStatus } from '@shared/types'
import { type RefObject, useCallback, useState } from 'react'
import type { OpProgressState } from '@/lib/useOpProgress'
import type { SyncAction } from './SyncButton'

interface Params {
  getRepoPath: () => string | undefined
  runOp: (fn: () => Promise<unknown>) => Promise<boolean>
  syncRef: RefObject<SyncStatus | null>
  branchRef: RefObject<BranchInfo | null>
  opProgress: OpProgressState | null
}

export function useSyncActions({ getRepoPath, runOp, syncRef, branchRef, opProgress }: Params) {
  const [syncRunning, setSyncRunning] = useState<SyncAction | null>(null)

  const doSync = useCallback(
    async (action: SyncAction) => {
      const repoPath = getRepoPath()
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
    [getRepoPath, runOp, syncRef, branchRef]
  )

  // The fill only shows when the in-flight op's kind matches the running sync
  // action (a pull and a background fetch report on different kinds).
  const syncKind: ProgressOpKind | null =
    syncRunning === null
      ? null
      : syncRunning === 'fetch'
        ? 'fetch'
        : syncRunning.startsWith('pull')
          ? 'pull'
          : 'push'
  const syncProgress = opProgress && opProgress.kind === syncKind ? opProgress.percent : null

  return { doSync, syncRunning, syncProgress }
}
