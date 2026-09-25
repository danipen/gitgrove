// The right-click menu for a branch: checkout, merge-into-current, rename,
// delete, copy, and the GitHub group (its PRs, the branch page). A builder
// rather than a component (like commitMenuItems) so the branch switcher and
// the command palette show the exact same menu for the same branch; the
// destructive entries only open confirmation dialogs — App runs the op.

import { branchUrl, headPullRequestsUrl } from '@shared/git-host-urls'
import { Icon } from '@/lib/icons'
import type { BranchPrs } from '@/lib/pr-order'
import type { ContextMenuItem } from './ContextMenu'

/** Branch operations that go through App (beyond plain checkout). */
export type BranchAction = 'new' | 'merge' | 'rename' | 'delete'

/** What the menu needs to know about the repo's branches. */
export interface BranchMenuContext {
  /** The checked-out branch (disables self-targeting entries), or null. */
  current: string | null
  /** Remote branch names (`origin/x`) — a local branch is linkable on the host
   *  only once it's published. */
  remote: readonly string[]
  /** The repo's GitHub web base, or null off GitHub (no GitHub group). */
  githubWebUrl: string | null
  /** Head branch → its PRs, as fetched so far. */
  prByBranch?: ReadonlyMap<string, BranchPrs>
}

/** What the menu's entries do. */
export interface BranchMenuActions {
  checkout: (name: string) => void
  branchAction: (action: BranchAction, name: string) => void
}

/** A remote row's head ref: `origin/foo` → `foo`, what a PR's head names. */
export const remoteHeadRef = (name: string) => name.slice(name.indexOf('/') + 1)

/**
 * The GitHub group for a branch's menu, under a single leading separator (or
 * nothing when none apply): one "Open Pull Request #N" entry when the branch
 * has a single PR, or a "Pull Requests (N)" submenu listing them (plus a "View
 * all on GitHub" entry when the host has more than we fetched) when it has
 * several — so the menu never spills 10 rows. Then "View Branch on GitHub"
 * when the branch is published.
 */
export function branchGithubItems(name: string, ctx: BranchMenuContext): ContextMenuItem[] {
  const entry = ctx.prByBranch?.get(name)
  const prs = entry?.prs ?? []
  const total = entry?.total ?? prs.length
  const items: ContextMenuItem[] = []
  const openPr = (url: string) => () => window.gitgrove.openExternal(url)

  if (total === 1 && prs.length === 1) {
    items.push({
      label: `Open Pull Request #${prs[0].number} on GitHub`,
      icon: <Icon.Github size={15} />,
      onClick: openPr(prs[0].url)
    })
  } else if (prs.length > 0) {
    const submenu: ContextMenuItem[] = prs.map((pr) => ({
      label: `Open Pull Request #${pr.number} on GitHub`,
      icon: <Icon.Github size={15} />,
      onClick: openPr(pr.url)
    }))
    if (ctx.githubWebUrl && total > prs.length) {
      submenu.push(
        {},
        {
          label: `View all ${total} on GitHub`,
          icon: <Icon.External size={15} />,
          onClick: openPr(headPullRequestsUrl(ctx.githubWebUrl, name))
        }
      )
    }
    items.push({ label: `Pull Requests (${total})`, icon: <Icon.PrOpen size={15} />, submenu })
  }

  // `branch.remote` holds entries like `origin/feature/x`, so comparing the
  // part after the remote name avoids offering a link that would 404.
  const published = ctx.remote.some((r) => remoteHeadRef(r) === name)
  if (ctx.githubWebUrl && published) {
    items.push({
      label: 'View Branch on GitHub',
      icon: <Icon.Github size={15} />,
      onClick: openPr(branchUrl(ctx.githubWebUrl, name))
    })
  }
  return items.length > 0 ? [{}, ...items] : []
}

const copyNameItem = (name: string): ContextMenuItem => ({
  label: 'Copy Branch Name',
  icon: <Icon.Copy size={15} />,
  onClick: () => window.gitgrove.clipboardWrite(name)
})

/** The full menu for a local branch. */
export function localBranchMenuItems(
  name: string,
  ctx: BranchMenuContext,
  actions: BranchMenuActions
): ContextMenuItem[] {
  const isCurrent = name === ctx.current
  return [
    {
      label: 'Checkout',
      icon: <Icon.Check size={15} />,
      disabled: isCurrent,
      onClick: () => actions.checkout(name)
    },
    {},
    {
      // The single entry point for bringing a branch in: the dialog offers
      // merge, squash AND rebase, each explained, with a conflict preview —
      // a bare "rebase onto this" item would duplicate it minus the safety.
      label: `Merge into ${ctx.current ?? 'current'}…`,
      icon: <Icon.Merge size={15} />,
      disabled: isCurrent,
      onClick: () => actions.branchAction('merge', name)
    },
    {},
    {
      label: 'Rename…',
      icon: <Icon.Pencil size={15} />,
      onClick: () => actions.branchAction('rename', name)
    },
    {
      label: 'Delete…',
      icon: <Icon.Trash size={15} />,
      danger: true,
      disabled: isCurrent,
      onClick: () => actions.branchAction('delete', name)
    },
    {},
    copyNameItem(name),
    ...branchGithubItems(name, ctx)
  ]
}

/** The menu for a remote branch: checkout and copy, plus the GitHub group
 *  (matched by its bare head ref, just like a local branch). Merge, rename
 *  and delete are local-branch operations. */
export function remoteBranchMenuItems(
  name: string,
  ctx: BranchMenuContext,
  actions: Pick<BranchMenuActions, 'checkout'>
): ContextMenuItem[] {
  return [
    {
      label: 'Checkout',
      icon: <Icon.Check size={15} />,
      onClick: () => actions.checkout(name)
    },
    {},
    copyNameItem(name),
    ...branchGithubItems(remoteHeadRef(name), ctx)
  ]
}
