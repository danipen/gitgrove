// Recovery screen for a repo whose folder has vanished (deleted, moved, or on
// an unmounted drive). Shown in place of the workspace — selecting a missing
// recent, or having the open repo's folder disappear, lands here instead of a
// cryptic git error. Three ways forward: Locate the folder's new home, Clone
// again (only when we remembered a clone URL), or Remove it; plus a quiet
// "Look again" by the title to re-test the path once it's been restored.
//
// styles: features/screens.css (.missing-repo)

import { prettyPath } from '@/lib/format'
import { Icon } from '@/lib/icons'

interface Props {
  name: string
  path: string
  /** Last-known clone URL; null hides "Re-clone" (nothing to clone from). */
  remoteUrl: string | null
  /** True while "Look again" re-tests the path. */
  checking: boolean
  onLocate: () => void
  onCloneAgain: () => void
  onRemove: () => void
  onCheckAgain: () => void
}

export function MissingRepo({
  name,
  path,
  remoteUrl,
  checking,
  onLocate,
  onCloneAgain,
  onRemove,
  onCheckAgain
}: Props) {
  return (
    <div className="welcome">
      <div className="welcome__card missing-repo">
        <div className="missing-repo__badge">
          <Icon.Alert size={26} />
        </div>
        <h1>“{name}” is missing</h1>
        <p>
          Its folder is no longer at <code className="missing-repo__path">{prettyPath(path)}</code>.
        </p>
        <button
          type="button"
          className="missing-repo__recheck"
          onClick={onCheckAgain}
          disabled={checking}
        >
          <Icon.Refresh size={13} />
          {checking ? 'Looking…' : 'Look again'}
        </button>
        <div className="missing-repo__actions">
          <button className="btn-primary" onClick={onLocate}>
            <Icon.Folder size={16} /> Locate…
          </button>
          {remoteUrl && (
            <button
              className="btn-ghost"
              data-tip="Clone it again from its remote"
              onClick={onCloneAgain}
            >
              <Icon.Download size={16} /> Clone again
            </button>
          )}
          <button
            className="btn-ghost"
            data-tip="Remove it from recent repositories"
            onClick={onRemove}
          >
            <Icon.Trash size={16} /> Remove
          </button>
        </div>
      </div>
    </div>
  )
}
