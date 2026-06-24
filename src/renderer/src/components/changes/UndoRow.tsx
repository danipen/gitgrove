// The undo affordance: a quiet row in the composer's header area, stacked with
// the stash chip (above the commit summary). Informational, not a call to
// action — it states what the last operation was and when ("Committed “…”" /
// "8 days ago"), with a small Undo button. That framing reads right even on a
// fresh repo open: it describes the last commit, it doesn't imply you just did
// something. Default typography throughout — no louder than the stash chip.
//
// Already-published changes never reach here (the snapshot withholds the undo
// once the tip is pushed — see readUndoSnapshot), so undoing can't rewrite
// remote history. Hidden while another operation owns the working tree.
//
// styles: features/changes.css

import type { UndoSnapshot } from '@shared/types'
import { Icon } from '@/lib/icons'

interface Props {
  undo: UndoSnapshot
  busy: boolean
  /** Run the undo (serialized + refreshed by the caller). */
  onUndo: () => void
}

export function UndoRow({ undo, busy, onUndo }: Props) {
  return (
    <div className="undo-row">
      <span className="undo-row__icon" aria-hidden>
        <Icon.Undo size={13} />
      </span>
      <div className="undo-row__text">
        {/* Full label on hover, but only when it's actually truncated. */}
        <span className="undo-row__label" data-tip={undo.label} data-tip-overflow="">
          {undo.label}
        </span>
        <span className="undo-row__time">{undo.relativeTime}</span>
      </div>
      <button
        className="undo-row__btn"
        disabled={busy}
        data-tip="Undo this and restore your previous state"
        onClick={onUndo}
      >
        Undo
      </button>
    </div>
  )
}
