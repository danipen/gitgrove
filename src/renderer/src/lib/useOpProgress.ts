// Determinate progress of the op this window started (checkout/fetch/pull/push/
// discard), already mapped onto one 0–100 scale; null while idle or before git
// reports anything. Only ops this window started count (`busy` is set around
// them) — the quiet background auto-fetch reports too and must never flash the
// buttons. The single clearing point is the end of `busy`.

import type { ProgressOpKind } from '@shared/types'
import { type RefObject, useEffect, useState } from 'react'
import { overallPercent } from './progress'

export interface OpProgressState {
  kind: ProgressOpKind
  percent: number
}

export function useOpProgress(
  busy: boolean,
  busyRef: RefObject<boolean>,
  getRepoPath: () => string | undefined
): OpProgressState | null {
  const [opProgress, setOpProgress] = useState<OpProgressState | null>(null)

  // Every op that reports progress runs under `busy`; when it ends, so does
  // the fill — one clearing point instead of one per operation.
  useEffect(() => {
    if (!busy) setOpProgress(null)
  }, [busy])

  useEffect(
    () =>
      window.gitgrove.onOpProgress((p) => {
        if (!busyRef.current || p.repoPath !== getRepoPath()) return
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
    [busyRef, getRepoPath]
  )

  return opProgress
}
