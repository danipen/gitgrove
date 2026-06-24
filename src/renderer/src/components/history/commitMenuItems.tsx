// The right-click menu for a history commit: checkout/branch/tag, the
// history-surgery actions (cherry-pick, revert, interactive rebase, resets)
// and hash copying. A builder rather than a component (like copyPathItems) so
// HistoryView's generic ContextMenu can render it; the destructive entries
// only open confirmation modals — App decides what actually runs.

import { commitUrl } from '@shared/git-host-urls'
import type { Commit, UndoableKind, UndoSnapshot } from '@shared/types'
import type { ContextMenuItem } from '@/components/common/ContextMenu'
import { Icon } from '@/lib/icons'

/** What the menu's entries need from App. */
export interface CommitMenuActions {
  /** Confirm-and-detach checkout of this commit. */
  checkoutCommit: (commit: Commit) => void
  newBranchAt: (commit: Commit) => void
  createTagAt: (commit: Commit) => void
  cherryPick: (commit: Commit) => void
  revert: (commit: Commit) => void
  /** Interactive rebase of `commits` (newest-first, ending at the clicked one). */
  interactiveRebase: (commits: Commit[], base: string) => void
  reset: (commit: Commit, mode: 'soft' | 'mixed') => void
  /** Hard reset goes through a confirmation modal. */
  confirmHardReset: (commit: Commit) => void
  /** Undo the last operation (the same one-click undo as the Changes banner). */
  undoLast: () => void
}

/** Menu label for the undo entry, named for what the last operation was. */
const UNDO_LABEL: Record<UndoableKind, string> = {
  commit: 'Undo This Commit',
  amend: 'Undo Amend',
  merge: 'Undo This Merge',
  rebase: 'Undo Rebase',
  'rebase-interactive': 'Undo Rebase',
  'cherry-pick': 'Undo Cherry-pick',
  revert: 'Undo Revert',
  reset: 'Undo Reset'
}

export function commitMenuItems(
  commit: Commit,
  commits: readonly Commit[],
  currentBranch: string,
  actions: CommitMenuActions,
  /** The repo's GitHub web base URL, when the host supports it — adds "View on GitHub". */
  webUrl: string | null,
  /** True when this commit isn't on the remote yet — its host page would 404, so
   *  "View on GitHub" is shown grayed out rather than leading to a dead link. */
  unpushed: boolean,
  /** The one-step undo, when available for *this* commit (HEAD only). Adds an
   *  "Undo …" entry mirroring the Changes banner — already withheld once pushed. */
  undo: UndoSnapshot | null
): ContextMenuItem[] {
  const idx = commits.findIndex((c) => c.hash === commit.hash)
  const isRoot = commit.parents.length === 0
  const isMerge = commit.parents.length > 1
  return [
    // The undo sits first, above the rest — the most likely "oops" action — and
    // only on the HEAD commit the undo would actually unwind.
    ...(undo && undo.headSha === commit.hash
      ? [
          {
            label: UNDO_LABEL[undo.kind],
            icon: <Icon.Undo size={15} />,
            onClick: () => actions.undoLast()
          },
          {}
        ]
      : []),
    {
      label: 'Checkout Commit…',
      icon: <Icon.Branch size={15} />,
      onClick: () => actions.checkoutCommit(commit)
    },
    {
      label: 'Create Branch Here…',
      icon: <Icon.Plus size={15} />,
      onClick: () => actions.newBranchAt(commit)
    },
    {
      label: 'Create Tag Here…',
      icon: <Icon.Tag size={15} />,
      onClick: () => actions.createTagAt(commit)
    },
    {},
    {
      label: `Cherry-pick onto ${currentBranch}`,
      icon: <Icon.CherryPick size={15} />,
      onClick: () => actions.cherryPick(commit)
    },
    {
      label: 'Revert Commit…',
      icon: <Icon.Undo size={15} />,
      disabled: isMerge,
      onClick: () => actions.revert(commit)
    },
    {
      label: 'Interactive Rebase from Here…',
      icon: <Icon.ListTodo size={15} />,
      // Needs a parent to rebase onto, and the commit must be in the loaded log.
      disabled: isRoot || idx < 0,
      onClick: () => actions.interactiveRebase(commits.slice(0, idx + 1), `${commit.hash}^`)
    },
    {},
    {
      label: `Reset ${currentBranch} Here (soft)`,
      icon: <Icon.Reset size={15} />,
      onClick: () => actions.reset(commit, 'soft')
    },
    {
      label: `Reset ${currentBranch} Here (mixed)`,
      icon: <Icon.Reset size={15} />,
      onClick: () => actions.reset(commit, 'mixed')
    },
    {
      label: `Reset ${currentBranch} Here (hard)…`,
      icon: <Icon.Reset size={15} />,
      danger: true,
      onClick: () => actions.confirmHardReset(commit)
    },
    {},
    {
      label: 'Copy Hash',
      icon: <Icon.Copy size={15} />,
      onClick: () => window.gitgrove.clipboardWrite(commit.hash)
    },
    {
      label: 'Copy Short Hash',
      icon: <Icon.Copy size={15} />,
      onClick: () => window.gitgrove.clipboardWrite(commit.shortHash)
    },
    ...(webUrl
      ? [
          {},
          {
            label: 'View Commit on GitHub',
            icon: <Icon.Github size={15} />,
            disabled: unpushed,
            onClick: () => window.gitgrove.openExternal(commitUrl(webUrl, commit.hash))
          }
        ]
      : [])
  ]
}
