// The create-branch dialog: name the branch, pick where it starts, and decide
// what happens to uncommitted changes — all in one calm step, never a second
// popup. Two GitHub-Desktop-inspired niceties, explained in plain words:
//
//  - when the current branch isn't the default one, the branch can start from
//    the default branch (preselected — new work usually shouldn't drag the
//    current branch along) or from the current branch;
//  - when the working tree is dirty, the changes either come along to the new
//    branch (preselected — it's where the user is heading) or stay behind on
//    the current branch, auto-stashed, with a welcome-back reminder when the
//    user returns (see StashReminder).
//
// The git choreography lives in main/git/write.ts createBranch.

import type { BranchChangesAction } from '@shared/types'
import { type FormEvent, useId, useState } from 'react'
import { DialogShell, validateRefName } from '@/components/common/Dialog'
import { pluralize } from '@/lib/format'
import { PendingChangesChoice } from './PendingChangesChoice'

/** What the dialog hands back on submit. */
export interface CreateBranchRequest {
  from?: string
  checkout: boolean
  changes?: BranchChangesAction
}

interface Props {
  /** Branch currently checked out. */
  current: string
  detached: boolean
  /** The repo's default branch, or null while unknown (hides the base picker). */
  defaultBranch: string | null
  /** Explicit base commit (branching at a history commit) and its short label. */
  from?: string
  fromLabel?: string
  initialName?: string
  /** Uncommitted changes in the working tree (drives the changes picker). */
  dirtyCount: number
  /** True while a merge/rebase/… owns the working tree — moving changes is off. */
  opInFlight: boolean
  busy: boolean
  onSubmit: (name: string, request: CreateBranchRequest) => void
  onCancel: () => void
}

type Base = 'default' | 'current'

export function CreateBranchDialog({
  current,
  detached,
  defaultBranch,
  from,
  fromLabel,
  initialName,
  dirtyCount,
  opInFlight,
  busy,
  onSubmit,
  onCancel
}: Props) {
  const id = useId()
  const [name, setName] = useState(initialName ?? '')
  const [error, setError] = useState<string | null>(null)
  const [base, setBase] = useState<Base>('default')
  const [changes, setChanges] = useState<BranchChangesAction>('bring')
  const [checkout, setCheckout] = useState(true)

  // The dialog reflects the repo as it was when it opened. Creating the branch
  // checks it out, which updates `current` (and can empty the working tree)
  // while this dialog is still on screen mid-submit; reacting to that would
  // briefly flip the base picker open just as the dialog closes. Freeze the
  // repo-derived inputs so the layout never shifts under the user.
  const [repo] = useState(() => ({ current, detached, defaultBranch, dirtyCount, opInFlight }))

  // The base picker only earns its space when there's a real choice: no
  // explicit commit base, a known default branch, and the user isn't on it.
  const showBase =
    !from && !repo.detached && repo.defaultBranch !== null && repo.defaultBranch !== repo.current
  // Moving changes needs a branch to leave them on (not detached) and a
  // working tree no operation owns; without a checkout nothing moves at all.
  const showChanges = repo.dirtyCount > 0 && checkout && !repo.detached && !repo.opInFlight

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const err = validateRefName(name)
    if (err) {
      setError(err)
      return
    }
    onSubmit(name.trim(), {
      from:
        from ?? (showBase && base === 'default' ? (repo.defaultBranch ?? undefined) : undefined),
      checkout,
      changes: showChanges ? changes : undefined
    })
  }

  return (
    <DialogShell
      title={from ? `New branch at ${fromLabel}` : 'New branch'}
      busy={busy}
      onClose={onCancel}
      width={showBase || showChanges ? 460 : undefined}
    >
      <form onSubmit={submit}>
        <div className="dlg-field">
          <label htmlFor={`${id}-name`}>Branch name</label>
          <input
            id={`${id}-name`}
            autoFocus
            placeholder="feature/my-change"
            value={name}
            disabled={busy}
            onChange={(e) => {
              setError(null)
              setName(e.target.value)
            }}
          />
        </div>

        {showBase && (
          <div className="option-cards" role="radiogroup" aria-label="Start the branch from">
            <p className="option-cards__label">Start from</p>
            <label className={`option-card${base === 'default' ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="branch-base"
                checked={base === 'default'}
                disabled={busy}
                onChange={() => setBase('default')}
              />
              <span className="option-card__text">
                <span className="option-card__title">
                  <code>{repo.defaultBranch}</code>
                </span>
                <span className="option-card__sub">
                  The default branch — the usual place to start something new, independent of{' '}
                  <code>{repo.current}</code>.
                </span>
              </span>
            </label>
            <label className={`option-card${base === 'current' ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="branch-base"
                checked={base === 'current'}
                disabled={busy}
                onChange={() => setBase('current')}
              />
              <span className="option-card__text">
                <span className="option-card__title">
                  <code>{repo.current}</code>
                </span>
                <span className="option-card__sub">
                  Your current branch — pick this to build on its work.
                </span>
              </span>
            </label>
          </div>
        )}

        {showChanges && (
          <>
            <p className="option-cards__label">
              Your {pluralize(repo.dirtyCount, 'pending change')}
            </p>
            <PendingChangesChoice
              current={repo.current}
              destination={name.trim() ? <code>{name.trim()}</code> : 'the new branch'}
              value={changes}
              busy={busy}
              onChange={setChanges}
            />
          </>
        )}

        <label className="dlg-check">
          <input
            type="checkbox"
            checked={checkout}
            disabled={busy}
            onChange={(e) => setCheckout(e.target.checked)}
          />
          Check out the new branch
        </label>

        {error && <p className="dlg-error">{error}</p>}
        <div className="trust__actions">
          <button
            type="button"
            className="btn-ghost btn-ghost--sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="btn-primary btn-primary--sm" disabled={busy}>
            {busy && <span className="about__spinner" aria-hidden />}
            Create branch
          </button>
        </div>
      </form>
    </DialogShell>
  )
}
