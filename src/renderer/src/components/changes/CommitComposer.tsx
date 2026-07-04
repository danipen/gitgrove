// The commit box at the bottom of the Changes sidebar: summary + optional
// description and a split action button whose label shows what will happen
// — how many files, how large, which branch — with a caret half that opens
// the Commit | Amend | Stash mode popover (owned by ChangesView). The mode
// arrives as a prop:
// switching to Amend pre-fills HEAD's message here, switching back restores
// the draft; Stash turns the box into a stash composer (message optional,
// the checked files are stashed). Commit signing follows the user's git
// config — commits run through the real `git commit` in the main process.
//
// While a merge is in progress the composer IS the merge's "continue":
// git's prepared message pre-fills the fields (editable — it's a normal
// commit message), the button becomes "Complete merge" and stays disabled,
// explaining itself, until every conflict is resolved.

import type { ChangedFile, RepoOpKind } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBytes, pluralize } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { isCmdOrCtrl, modKeyLabel } from '@/lib/platform'
import { AiComposerControls } from './AiComposerControls'

export type CommitMode = 'commit' | 'amend' | 'stash'

/**
 * A commit message to drop into the composer from outside (e.g. after undoing a
 * commit restores its message). `nonce` changes each time so re-injecting the
 * same text still applies.
 */
export interface ComposerDraft {
  summary: string
  description: string
  nonce: number
}

/** What blocks the composer during each non-merge op, for the tooltip. */
const OP_NOUN: Record<Exclude<RepoOpKind, 'merging'>, string> = {
  rebasing: 'rebase',
  'cherry-picking': 'cherry-pick',
  reverting: 'revert'
}

interface Props {
  repoPath: string
  /** Current branch name, for the button label. */
  branch: string
  /** Files included in the next commit — the button is disabled at zero (unless amending). */
  includedCount: number
  /** On-disk size of the included files (bytes), or null while unknown. */
  commitSize: number | null
  /** Disabled while another operation runs. */
  busy: boolean
  /** Composer mode (controlled by the switch in the row above). */
  mode: CommitMode
  /** In-flight repo op: 'merging' turns the composer into the merge
   *  concluder; any other op disables it (their continue lives in the banner). */
  repoOp: RepoOpKind | null
  /** Conflicted paths left — blocks committing until zero. */
  conflicts: number
  /** Branch being merged in, when known — for the pre-merge button label. */
  mergeSource: string | null
  /** Fixed height (px) of the description box — driven by the panel splitter. */
  descriptionHeight: number
  /** Receives the description textarea node, for live splitter previews. */
  descriptionRef?: (el: HTMLTextAreaElement | null) => void
  /** A message to load into the fields from outside (e.g. after undoing a commit). */
  injectedDraft?: ComposerDraft | null
  /** Receives the mode button node — the mode popover anchors to it. */
  modeMenuRef: (el: HTMLButtonElement | null) => void
  /** Open the mode popover (Commit / Amend / Stash), owned by ChangesView. */
  onOpenModeMenu: () => void
  onCommit: (message: string, amend: boolean) => Promise<boolean>
  /** Stash the checked files with an optional message. */
  onStash: (message: string) => Promise<boolean>
  /** Snapshot of the checkbox selection, for the AI message generator. */
  buildAiSelection: () => { files: ChangedFile[]; patches: string[] }
  /** Open Settings → AI (the ✨ button's teaser when nothing is connected). */
  onSetupAi: () => void
  /** Surface a failed generation (toast). */
  onError: (e: unknown) => void
}

export function CommitComposer({
  repoPath,
  branch,
  includedCount,
  commitSize,
  busy,
  mode,
  repoOp,
  conflicts,
  mergeSource,
  descriptionHeight,
  descriptionRef,
  injectedDraft,
  modeMenuRef,
  onOpenModeMenu,
  onCommit,
  onStash,
  buildAiSelection,
  onSetupAi,
  onError
}: Props) {
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [committing, setCommitting] = useState(false)

  // Remember what the composer held before amend pre-filled it, so leaving
  // amend mode restores the user's draft instead of leaving HEAD's message.
  const draftRef = useRef<{ summary: string; description: string } | null>(null)

  // Reset on repo switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoPath is the intentional reset trigger
  useEffect(() => {
    setSummary('')
    setDescription('')
    draftRef.current = null
  }, [repoPath])

  // React to the (controlled) mode: entering Amend saves the draft and
  // pre-fills HEAD's message; leaving it restores the draft. Stash shares
  // the draft — a half-written commit message survives a quick stash detour.
  const prevAmend = useRef(mode === 'amend')
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the amend flip should trigger this
  useEffect(() => {
    const amend = mode === 'amend'
    if (amend === prevAmend.current) return
    prevAmend.current = amend
    if (amend) {
      draftRef.current = { summary, description }
      window.gitgrove
        .lastCommitMessage(repoPath)
        .then((msg) => {
          const [first, ...rest] = msg.split('\n')
          setSummary(first ?? '')
          setDescription(rest.join('\n').replace(/^\n+/, ''))
        })
        .catch(() => {})
    } else {
      const draft = draftRef.current
      setSummary(draft?.summary ?? '')
      setDescription(draft?.description ?? '')
      draftRef.current = null
    }
  }, [mode])

  // Load a draft pushed from outside (e.g. an undone commit's message). Keyed on
  // the nonce so re-injecting identical text still applies; clears the saved
  // amend draft so the restored message is what a later mode flip restores.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the nonce should trigger this
  useEffect(() => {
    if (!injectedDraft) return
    setSummary(injectedDraft.summary)
    setDescription(injectedDraft.description)
    draftRef.current = null
  }, [injectedDraft?.nonce])

  const amend = mode === 'amend'
  const stash = mode === 'stash'
  const merging = repoOp === 'merging'
  // Rebase/cherry-pick/revert continue from the banner — committing here
  // mid-op would tangle their state.
  const blockedByOp = repoOp !== null && !merging

  // Entering a merge saves the draft and pre-fills git's prepared merge
  // message (editable — completing the merge is a normal commit); leaving
  // (completed or aborted) restores the draft. Mirrors the amend flip below.
  const prevMerging = useRef(merging)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the merge flip should trigger this
  useEffect(() => {
    if (merging === prevMerging.current) return
    prevMerging.current = merging
    if (merging) {
      draftRef.current = { summary, description }
      window.gitgrove
        .mergeMessage(repoPath)
        .then((msg) => {
          const [first, ...rest] = msg.split('\n')
          setSummary(first ?? '')
          setDescription(rest.join('\n').replace(/^\n+/, ''))
        })
        .catch(() => {})
    } else {
      const draft = draftRef.current
      setSummary(draft?.summary ?? '')
      setDescription(draft?.description ?? '')
      draftRef.current = null
    }
  }, [merging])

  // Stash: message optional, but something must be checked. Commit: summary
  // required, something checked (unless amending — message-only amends are
  // fine). A merge commits the whole tree, so only the summary and the
  // conflict count gate it; other ops block the composer entirely.
  const canAct =
    !busy &&
    !committing &&
    !blockedByOp &&
    (stash
      ? includedCount > 0
      : merging
        ? summary.trim().length > 0 && conflicts === 0
        : summary.trim().length > 0 && (includedCount > 0 || amend))

  const act = useCallback(async () => {
    if (!canAct) return
    setCommitting(true)
    try {
      // Joined generically: a stash may have a description with no summary.
      const message = [summary.trim(), description.trim()].filter(Boolean).join('\n\n')
      const ok = stash ? await onStash(message) : await onCommit(message, amend)
      if (ok) {
        setSummary('')
        setDescription('')
        draftRef.current = null
      }
    } finally {
      setCommitting(false)
    }
  }, [canAct, summary, description, amend, stash, onCommit, onStash])

  // Cmd+Enter (macOS) / Ctrl+Enter (Windows/Linux) acts from either field.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isCmdOrCtrl(e) && e.key === 'Enter') {
      e.preventDefault()
      act()
    }
  }

  // Why the action button is unavailable, surfaced as its tooltip so a disabled
  // button explains itself instead of silently refusing. null = ready to act.
  // (Rendered via aria-disabled, not the native `disabled` attr, so the button
  // still receives hover events and the tooltip can show — the click stays
  // guarded by `canAct` inside `act`.)
  const disabledReason =
    busy || committing
      ? null
      : repoOp !== null && repoOp !== 'merging'
        ? `A ${OP_NOUN[repoOp]} is in progress — continue or abort it in the banner above`
        : merging
          ? conflicts > 0
            ? `Resolve ${pluralize(conflicts, 'conflicted file')} to complete the merge`
            : summary.trim().length === 0
              ? 'Write a commit summary to complete the merge'
              : null
          : stash
            ? includedCount === 0
              ? 'Select some files to stash'
              : null
            : includedCount === 0 && !amend
              ? 'Select some changes to commit'
              : summary.trim().length === 0
                ? 'Write a commit summary to continue'
                : null

  // Why the ✨ button can't generate right now (its tooltip). Independent of
  // the commit button's gating: a message-only amend can generate, and an
  // empty summary is exactly when generating is most useful.
  const aiDisabledReason =
    busy || committing
      ? 'Wait for the current operation to finish'
      : includedCount === 0 && !amend
        ? mode === 'stash'
          ? 'Select some files to name a stash for'
          : 'Select some changes to describe'
        : null

  // A generated message lands like typed text: draft bookkeeping untouched, so
  // mode flips (amend/merge) keep restoring exactly what the fields held.
  const onAiMessage = useCallback((aiSummary: string, aiDescription: string) => {
    setSummary(aiSummary.slice(0, 500))
    setDescription(aiDescription)
  }, [])

  const size = commitSize !== null && commitSize > 0 ? ` · ${formatBytes(commitSize)}` : ''
  const label = merging
    ? `Complete merge${mergeSource ? ` of ${mergeSource}` : ''} into ${branch}`
    : stash
      ? includedCount > 0
        ? `Stash ${pluralize(includedCount, 'file')}${size}`
        : 'Stash'
      : amend
        ? 'Amend last commit'
        : includedCount > 0
          ? `Commit ${pluralize(includedCount, 'file')} to ${branch}${size}`
          : `Commit to ${branch}`

  return (
    <div className="composer">
      {/* Merges keep git's prepared message — no AI second-guessing there. */}
      {!merging && !blockedByOp && (
        <AiComposerControls
          repoPath={repoPath}
          mode={mode}
          disabledReason={aiDisabledReason}
          buildSelection={buildAiSelection}
          onMessage={onAiMessage}
          onSetupAi={onSetupAi}
          onError={onError}
        />
      )}
      <input
        className="composer__summary"
        placeholder={
          merging
            ? 'Merge commit summary'
            : stash
              ? 'Stash message (optional)'
              : amend
                ? 'Amend commit summary'
                : 'Commit summary'
        }
        value={summary}
        maxLength={500}
        disabled={busy || committing}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <textarea
        ref={descriptionRef}
        className="composer__description"
        placeholder="Description (optional)"
        value={description}
        style={{ height: descriptionHeight }}
        disabled={busy || committing}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer__actions">
        <button
          className="btn-primary composer__commit"
          aria-disabled={!canAct}
          data-tip={
            disabledReason ??
            (merging
              ? `Create the merge commit (${modKeyLabel}↵)`
              : stash
                ? `Stash selected files (${modKeyLabel}↵)`
                : `Commit selected changes (${modKeyLabel}↵)`)
          }
          onClick={act}
        >
          {committing ? (
            <span className="about__spinner" aria-hidden />
          ) : merging ? (
            <Icon.Merge size={14} />
          ) : stash ? (
            <Icon.Stash size={14} />
          ) : amend ? (
            <Icon.Pencil size={14} />
          ) : (
            <Icon.Changes size={14} />
          )}
          <span className="composer__commit-label">{label}</span>
        </button>
        <button
          type="button"
          ref={modeMenuRef}
          className="composer__mode-btn"
          disabled={busy || committing || repoOp !== null}
          aria-haspopup="menu"
          aria-label="Change mode"
          data-tip="Mode: Commit · Amend · Stash"
          onClick={onOpenModeMenu}
        >
          <Icon.Chevron size={12} />
        </button>
      </div>
    </div>
  )
}
