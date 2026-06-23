// The "create a pull request" nudge at the top of Changes: shown when the
// current branch is published to a GitHub remote, isn't the default branch, and
// has no open PR yet — the natural next step right after publishing. The single
// button opens the host's pre-filled compare page in the browser, so the PR is
// composed where the user's description templates, reviewers and labels already
// live rather than in a half-rebuilt in-app form. It clears itself once a PR
// exists (the branch's #123 pill takes over from there).
// styles: features/changes.css (.pr-banner)

import { Icon } from '@/lib/icons'

interface Props {
  branch: string
  /** The host compare URL to open (base...head, pre-expanded into the PR form). */
  compareUrl: string
}

export function PublishedBranchBanner({ branch, compareUrl }: Props) {
  return (
    <div className="pr-banner" role="status">
      <span className="pr-banner__icon" aria-hidden>
        <Icon.Github size={15} />
      </span>
      <div className="pr-banner__text">
        <strong>{branch} is published</strong>
        <span>Open a pull request to propose merging it.</span>
      </div>
      <button
        className="btn-primary btn-primary--sm"
        data-tip="Open a pull request on GitHub"
        onClick={() => window.gitgrove.openExternal(compareUrl)}
      >
        Create Pull Request
      </button>
    </div>
  )
}
