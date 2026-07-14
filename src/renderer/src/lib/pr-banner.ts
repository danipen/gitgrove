// The "Create Pull Request" banner's gate, kept pure (no React) so every
// condition is unit-tested directly rather than through the hook.

import { compareUrl } from '@shared/git-host-urls'
import type { BranchInfo, RepoHostInfo, SyncStatus } from '@shared/types'

interface BannerParams {
  /** False until the current branch's first PR fetch resolves — the banner must
   *  not flash before we know whether the branch already has a PR. */
  prsLoaded: boolean
  hostInfo: RepoHostInfo | null
  branch: BranchInfo | null
  sync: SyncStatus | null
  /** Branch names that carry a PR of any kind (open, merged or closed). */
  branchesWithPrs: ReadonlySet<string>
}

/**
 * The compare URL for the "Create Pull Request" banner, or null when it
 * shouldn't show. Shown only on a GitHub host, for a branch that is genuinely
 * published, isn't the default branch, and has no PR of any kind yet.
 *
 * "Published" means the branch's upstream remote branch *actually exists* — not
 * merely that one is configured. A branch whose configured upstream was deleted
 * on the remote (e.g. a stale local `master` after the remote renamed its
 * default to `main`) still reports `branch.upstream` in git's porcelain, but
 * there's nothing on the remote to open a PR from, so the banner must stay hidden.
 */
export function createPrBannerUrl({
  prsLoaded,
  hostInfo,
  branch,
  sync,
  branchesWithPrs
}: BannerParams): string | null {
  if (!prsLoaded) return null
  if (hostInfo?.provider !== 'github' || !hostInfo.webUrl) return null
  if (!branch || branch.detached || !branch.defaultBranch) return null
  const current = branch.current
  if (!current || current === branch.defaultBranch) return null
  // Require the upstream remote-tracking ref to still exist among the remote
  // branches — a configured-but-deleted upstream can't back a pull request.
  if (!sync?.upstream || !branch.remote.includes(sync.upstream)) return null
  // Any PR — open, merged or closed — means the branch's PR story is already
  // told (the menu's "Open Pull Request #N" reaches it), so don't nag to create
  // another. In particular, a just-merged branch must not reopen this.
  if (branchesWithPrs.has(current)) return null
  return compareUrl(hostInfo.webUrl, branch.defaultBranch, current)
}
