// The undo banner: shown at the top of Changes when the last history-changing
// operation (commit, amend, merge, rebase, cherry-pick, revert, reset) can be
// taken back in one step. A calm, neutral row — undoing what you just did is a
// normal correction, not a warning — with a single Undo button, per the
// sidebar-banner rule. Mutually exclusive with the in-progress op banner: you
// can't undo a finished operation while another one owns the working tree.
//
// Already-published changes never reach here: the snapshot withholds the undo
// once the tip is pushed (see readUndoSnapshot), mirroring GitHub Desktop — so
// the banner can't rewrite remote history, and needs no warning of its own.
//
// styles: features/banners.css

import type { UndoSnapshot } from '@shared/types'
import { Icon } from '@/lib/icons'

interface Props {
  undo: UndoSnapshot
  busy: boolean
  /** Run the undo (serialized + refreshed by the caller). */
  onUndo: () => void
}

export function UndoBanner({ undo, busy, onUndo }: Props) {
  return (
    <div className="undo-banner" role="status">
      <span className="undo-banner__icon" aria-hidden>
        <Icon.Undo size={15} />
      </span>
      <div className="undo-banner__text">
        <strong>{undo.label}</strong>
        <span>{undo.relativeTime} — undo it to get back to where you were.</span>
      </div>
      <div className="undo-banner__actions">
        <button
          className="btn-ghost btn-ghost--sm"
          disabled={busy}
          data-tip="Undo this and restore your previous state"
          onClick={onUndo}
        >
          Undo
        </button>
      </div>
    </div>
  )
}
