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
//
// The name field carries the AI ghost suggestion: with a backend connected and
// a dirty working tree, a slug generated from the pending changes streams in
// as ghost text — Tab accepts it, typing dismisses it, Enter on the empty
// field accepts and creates in one stroke. Unconfigured, the ✨ opens the
// setup teaser instead (see AiTeaserPopover). styles: features/ai.css (.ai-field)

import type { BranchChangesAction } from '@shared/types'
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { AiTeaserPopover } from '@/components/common/AiTeaserPopover'
import { DialogShell, validateRefName } from '@/components/common/Dialog'
import { useAiGeneration, useAiStatus } from '@/lib/ai'
import { pluralize } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { PendingChangesChoice } from './PendingChangesChoice'

/** What the dialog hands back on submit. */
export interface CreateBranchRequest {
  from?: string
  checkout: boolean
  changes?: BranchChangesAction
}

interface Props {
  repoPath: string
  /** Open Settings → AI (the ✨ teaser's one button). */
  onSetupAi: () => void
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
  repoPath,
  onSetupAi,
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

  // ── AI ghost suggestion ──
  const aiStatus = useAiStatus()
  const suggestion = useAiGeneration() // failures degrade silently — a ghost never nags
  const [teaserOpen, setTeaserOpen] = useState(false)
  const sparkleRef = useRef<HTMLButtonElement>(null)
  const canSuggest = repo.dirtyCount > 0

  const suggest = () =>
    suggestion.run((requestId) => window.gitgrove.aiBranchName(repoPath, { requestId }))

  // Auto-suggest once, as the dialog opens: exactly the roadmap UX — the
  // field greets the user with a name already forming. Only when a backend is
  // connected, there are changes to name from, and no caller-provided name.
  const autoRan = useRef(false)
  useEffect(() => {
    if (autoRan.current || !aiStatus || !canSuggest || initialName) return
    autoRan.current = true
    suggest()
    // biome-ignore lint/correctness/useExhaustiveDependencies: fire once when the status resolves
  }, [aiStatus])

  // The ghost shows while the field is empty: the streaming raw text as it
  // forms, then the sanitized slug (run() resolves with it). Accepting waits
  // for the final slug — a half-streamed name is never committed to the field.
  const ghostReady = !suggestion.generating && suggestion.text.length > 0
  const ghost = !name && (suggestion.generating || suggestion.text.length > 0)

  const acceptGhost = (): string | null => {
    if (!ghostReady || name) return null
    setName(suggestion.text)
    return suggestion.text
  }

  const onNameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && !e.shiftKey && acceptGhost() !== null) e.preventDefault()
  }

  const sparkleTip = !aiStatus
    ? 'Suggest a branch name with AI — click to set up'
    : suggestion.generating
      ? 'Stop suggesting'
      : canSuggest
        ? 'Suggest a name from your pending changes'
        : 'Nothing to suggest from — no pending changes'

  const onSparkle = () => {
    if (!aiStatus) {
      setTeaserOpen(true)
      return
    }
    if (suggestion.generating) suggestion.stop()
    else if (canSuggest && !busy) suggest()
  }

  // The base picker only earns its space when there's a real choice: no
  // explicit commit base, a known default branch, and the user isn't on it.
  const showBase =
    !from && !repo.detached && repo.defaultBranch !== null && repo.defaultBranch !== repo.current
  // Moving changes needs a branch to leave them on (not detached) and a
  // working tree no operation owns; without a checkout nothing moves at all.
  const showChanges = repo.dirtyCount > 0 && checkout && !repo.detached && !repo.opInFlight

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // Enter on the empty field accepts the ready ghost and creates in one
    // stroke — suggestion straight to branch, the whole point of the ghost.
    const accepted = !name.trim() ? acceptGhost() : null
    const finalName = accepted ?? name
    const err = validateRefName(finalName)
    if (err) {
      setError(err)
      return
    }
    onSubmit(finalName.trim(), {
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
          <div className="ai-field">
            <input
              id={`${id}-name`}
              autoFocus
              placeholder={ghost ? '' : 'feature/my-change'}
              value={name}
              disabled={busy}
              aria-description={ghostReady ? `Suggested: ${suggestion.text} — Tab accepts` : ''}
              onChange={(e) => {
                setError(null)
                setName(e.target.value)
                // Typing means "I have my own name" — stop the stream quietly.
                if (suggestion.generating) suggestion.stop()
              }}
              onKeyDown={onNameKeyDown}
            />
            {ghost && (
              <span className="ai-field__ghost" aria-hidden>
                <span className="ai-field__ghost-text">{suggestion.text}</span>
                {ghostReady && <kbd className="ai-field__hint">Tab</kbd>}
              </span>
            )}
            <button
              ref={sparkleRef}
              type="button"
              className={`ai-btn ai-field__btn${suggestion.generating ? ' is-generating' : ''}`}
              aria-disabled={!!aiStatus && !suggestion.generating && !canSuggest}
              aria-label={sparkleTip}
              data-tip={sparkleTip}
              onClick={onSparkle}
            >
              {suggestion.generating ? (
                <span className="ai-btn__spinner" aria-hidden />
              ) : (
                <Icon.Sparkle size={14} />
              )}
            </button>
          </div>
        </div>

        <AiTeaserPopover
          anchor={sparkleRef.current}
          open={teaserOpen}
          onClose={() => setTeaserOpen(false)}
          title="Name this branch with AI"
          body="GitGrove suggests a name from your pending changes, in your repo's naming style."
          onSetup={onSetupAi}
        />

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
