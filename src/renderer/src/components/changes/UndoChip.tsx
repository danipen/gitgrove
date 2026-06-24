// The undo affordance: a subtle chip in the composer's header row (opposite the
// stash chip), not a banner. Undo is ambient state, not a transient action you
// must resolve — so it stays quiet and out of the way until you reach for it. A
// short verb names the last operation; the tooltip carries the full label and
// when it happened. Already-published changes never reach here (the snapshot
// withholds the undo once the tip is pushed — see readUndoSnapshot).
//
// styles: features/changes.css

import type { UndoableKind, UndoSnapshot } from '@shared/types'
import { Icon } from '@/lib/icons'

/** Short chip verb for the last operation (the tooltip carries the detail). */
const VERB: Record<UndoableKind, string> = {
  commit: 'Undo commit',
  amend: 'Undo amend',
  merge: 'Undo merge',
  rebase: 'Undo rebase',
  'rebase-interactive': 'Undo rebase',
  'cherry-pick': 'Undo cherry-pick',
  revert: 'Undo revert',
  reset: 'Undo reset'
}

interface Props {
  undo: UndoSnapshot
  busy: boolean
  /** Run the undo (serialized + refreshed by the caller). */
  onUndo: () => void
}

export function UndoChip({ undo, busy, onUndo }: Props) {
  return (
    <button
      className="undo-chip"
      disabled={busy}
      data-tip={`${undo.label} · ${undo.relativeTime}`}
      onClick={onUndo}
    >
      <Icon.Undo size={13} />
      {VERB[undo.kind]}
    </button>
  )
}
