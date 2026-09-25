// What the command palette does with a result: Enter reveals it where it
// lives (a branch in the Graph, a file in Changes or its history, a commit in
// History, …); the row's menu offers everything else — the same menu the
// object has in its home view, so acting on it never needs the reveal first.

import type { AppCommandId } from '@shared/commands'
import { commandTitle } from '@shared/commands'
import type { ChangedFile, Commit, StashEntry } from '@shared/types'
import type { Modal } from '@/components/app/AppModals'
import {
  type BranchAction,
  type BranchMenuContext,
  localBranchMenuItems,
  remoteBranchMenuItems
} from '@/components/common/branchMenuItems'
import type { ContextMenuItem } from '@/components/common/ContextMenu'
import { copyPathItems } from '@/components/common/copyPathItems'
import { type FileHistoryMode, fileHistoryItems } from '@/components/common/fileHistoryItems'
import type { GraphRevealTarget } from '@/components/graph/reveal'
import { Icon } from '@/lib/icons'
import { platform } from '@/lib/platform'
import type { PaletteItem } from './paletteResults'

/** What the palette asks App (and itself) to do. */
export interface PaletteActions {
  repoPath: string | null
  runCommand: (id: AppCommandId) => void
  revealInGraph: (target: GraphRevealTarget) => void
  revealCommit: (commit: Commit) => void
  /** A file result: its pending change in Changes, else its history. */
  openFile: (path: string, change: ChangedFile | null) => void
  openFileHistory: (path: string, mode: FileHistoryMode) => void
  openRepo: (path: string) => void
  checkout: (name: string) => void
  branchAction: (action: BranchAction, name: string) => void
  openModal: (modal: Modal) => void
  /** The History/Graph commit menu, for a commit result. */
  commitMenuFor: (commit: Commit) => ContextMenuItem[]
  /** Run a mutating op (serialized, refreshed, errors → toast). */
  runOp: (fn: () => Promise<unknown>) => Promise<boolean>
  reviewStash: (stash: StashEntry) => void
}

/** Enter on a result: reveal it (or, for a command, run it). */
export function activateItem(item: PaletteItem, actions: PaletteActions): void {
  switch (item.kind) {
    case 'command':
      actions.runCommand(item.command.id)
      break
    case 'branch':
      actions.revealInGraph({ kind: 'branch', name: item.ref.name, hash: item.ref.hash })
      break
    case 'tag':
      actions.revealInGraph({ kind: 'commit', hash: item.ref.hash })
      break
    case 'commit':
      actions.revealCommit(item.commit)
      break
    case 'file':
      actions.openFile(item.path, item.change)
      break
    case 'stash':
      actions.reviewStash(item.stash)
      break
    case 'place':
      actions.openRepo(item.path)
      break
  }
}

const revealInGraphItem = (onClick: () => void): ContextMenuItem => ({
  label: 'Show in Graph',
  icon: <Icon.Branch size={15} />,
  onClick
})

/** The row's menu, or null for results that have nothing beyond Enter. */
export function itemMenu(
  item: PaletteItem,
  actions: PaletteActions,
  branches: BranchMenuContext
): ContextMenuItem[] | null {
  const gg = window.gitgrove
  switch (item.kind) {
    case 'command':
      return null
    case 'branch': {
      const { name, hash } = item.ref
      const reveal = revealInGraphItem(() => actions.revealInGraph({ kind: 'branch', name, hash }))
      const rest =
        item.ref.kind === 'local'
          ? localBranchMenuItems(name, branches, actions)
          : remoteBranchMenuItems(name, branches, actions)
      return [reveal, {}, ...rest]
    }
    case 'tag': {
      const { name, hash } = item.ref
      return [
        revealInGraphItem(() => actions.revealInGraph({ kind: 'commit', hash })),
        {},
        {
          label: 'Checkout Tag…',
          icon: <Icon.Check size={15} />,
          onClick: () => actions.openModal({ kind: 'checkout-commit', hash, shortHash: name })
        },
        {
          label: 'Create Branch Here…',
          icon: <Icon.Plus size={15} />,
          onClick: () => actions.openModal({ kind: 'new-branch', from: hash, fromLabel: name })
        },
        {},
        {
          label: 'Copy Tag Name',
          icon: <Icon.Copy size={15} />,
          onClick: () => gg.clipboardWrite(name)
        },
        {},
        {
          label: 'Delete Tag…',
          icon: <Icon.Trash size={15} />,
          danger: true,
          onClick: () => actions.openModal({ kind: 'delete-tag', name })
        }
      ]
    }
    case 'commit':
      return [
        {
          label: 'Show in History',
          icon: <Icon.History size={15} />,
          onClick: () => actions.revealCommit(item.commit)
        },
        {},
        ...actions.commitMenuFor(item.commit)
      ]
    case 'file': {
      const { path, change } = item
      if (!actions.repoPath) return null
      // The shared builders read only the path of a file they're handed.
      const file: ChangedFile = change ?? { path, status: 'modified', staged: false }
      const repoPath = actions.repoPath
      return [
        ...(change
          ? [
              {
                label: 'Show in Changes',
                icon: <Icon.Changes size={15} />,
                onClick: () => actions.openFile(path, change)
              },
              {}
            ]
          : []),
        ...fileHistoryItems(file, null, (p, mode) => actions.openFileHistory(p, mode)),
        {},
        {
          label: 'Open File',
          icon: <Icon.External size={15} />,
          disabled: change?.status === 'deleted',
          onClick: () => gg.openFileInEditor(repoPath, path)
        },
        ...copyPathItems([file], repoPath)
      ]
    }
    case 'stash': {
      const { stash } = item
      const repoPath = actions.repoPath
      if (!repoPath) return null
      const apply = (pop: boolean) => () =>
        actions.runOp(() => gg.stashApply(repoPath, stash.index, pop))
      return [
        {
          label: 'Review…',
          icon: <Icon.Diff size={15} />,
          onClick: () => actions.reviewStash(stash)
        },
        {},
        // Auto-stashes only Restore (apply + clear) — see StashPanel.
        ...(stash.auto
          ? [{ label: 'Restore', icon: <Icon.Undo size={15} />, onClick: apply(true) }]
          : [
              { label: 'Apply', icon: <Icon.Download size={15} />, onClick: apply(false) },
              { label: 'Apply and Delete', icon: <Icon.Download size={15} />, onClick: apply(true) }
            ]),
        {},
        {
          label: 'Delete Stash',
          icon: <Icon.Trash size={15} />,
          danger: true,
          onClick: () => actions.runOp(() => gg.stashDrop(repoPath, stash.index))
        }
      ]
    }
    case 'place':
      return [
        {
          label: 'Open',
          icon: <Icon.Repo size={15} />,
          onClick: () => actions.openRepo(item.path)
        },
        {
          label: 'Open in New Window',
          icon: <Icon.NewWindow size={15} />,
          onClick: () => gg.openRepoInNewWindow(item.path)
        },
        {},
        {
          label: commandTitle('reveal-repo', platform),
          icon: <Icon.Folder size={15} />,
          onClick: () => gg.revealRepo(item.path)
        },
        {
          label: 'Copy Path',
          icon: <Icon.Copy size={15} />,
          onClick: () => gg.clipboardWrite(item.path)
        }
      ]
  }
}

/**
 * The menu with every entry closing the palette first: an entry may open a
 * dialog or move the view, and neither should happen underneath it.
 */
export function closingFirst(items: ContextMenuItem[], close: () => void): ContextMenuItem[] {
  return items.map((item) => ({
    ...item,
    onClick: item.onClick
      ? () => {
          close()
          item.onClick?.()
        }
      : undefined,
    submenu: item.submenu ? closingFirst(item.submenu, close) : undefined
  }))
}
