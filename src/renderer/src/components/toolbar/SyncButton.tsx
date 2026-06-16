// The toolbar's fetch/pull/push control. One adaptive button shows the most
// useful action for the branch's state (publish → pull → push → fetch), with
// ahead/behind badges, and a chevron opens the full menu (fetch, pull,
// pull --rebase, push, force push) — all sync in a single compact pill.

import type { SyncStatus } from '@shared/types'
import { useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/common/Dialog'
import { Popover } from '@/components/common/Popover'
import { pluralize } from '@/lib/format'
import { Icon } from '@/lib/icons'

export type SyncAction = 'fetch' | 'pull' | 'pull-rebase' | 'push' | 'force-push' | 'publish'

interface Props {
  sync: SyncStatus | null
  branch: string
  detached: boolean
  busy: boolean
  /** The action currently running, to spin the right glyph. */
  running: SyncAction | null
  /** Determinate 0–100 of the running action, or null before git reports any. */
  progress?: number | null
  onAction: (action: SyncAction) => void
}

export function SyncButton({
  sync,
  branch,
  detached,
  busy,
  running,
  progress = null,
  onAction
}: Props) {
  const [open, setOpen] = useState(false)
  const [confirmForce, setConfirmForce] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)

  // Nothing to sync with: no remotes configured, or detached HEAD.
  if (!sync || sync.remotes.length === 0 || detached) return null

  const primary: SyncAction = !sync.upstream
    ? 'publish'
    : sync.behind > 0
      ? 'pull'
      : sync.ahead > 0
        ? 'push'
        : 'fetch'

  const RUNNING_LABEL: Record<SyncAction, string> = {
    fetch: 'Fetching…',
    pull: 'Pulling…',
    'pull-rebase': 'Pulling…',
    push: 'Pushing…',
    'force-push': 'Pushing…',
    publish: 'Publishing…'
  }

  const label =
    running !== null
      ? RUNNING_LABEL[running]
      : primary === 'publish'
        ? 'Publish branch'
        : primary === 'pull'
          ? 'Pull'
          : primary === 'push'
            ? 'Push'
            : 'Fetch'

  // A one-line read of where the branch stands relative to its remote, shown
  // under the action so the button explains itself at a glance. While an op is
  // running we surface the upstream it's talking to instead of a stale state.
  const remote = sync.remotes[0]
  const sub =
    running !== null
      ? (sync.upstream ?? remote)
      : primary === 'publish'
        ? `Publish to ${remote}`
        : primary === 'pull'
          ? sync.ahead > 0
            ? `Diverged from ${remote}`
            : `Behind ${remote}`
          : primary === 'push'
            ? `Ahead of ${remote}`
            : 'Up to date'

  // One plain-language description per action, the single source of truth shared
  // by the dropdown items and the main button's hover tooltip — so the two can
  // never drift out of sync.
  const describe = (action: SyncAction): string => {
    switch (action) {
      case 'fetch':
        return 'Check the remote for new commits — nothing is merged'
      case 'pull':
        return sync.behind > 0
          ? `Merge ${pluralize(sync.behind, 'incoming commit')} into ${branch}`
          : `Merge ${sync.upstream}'s changes into ${branch}`
      case 'pull-rebase':
        return 'Replay your commits on top — no merge commit'
      case 'push':
        return sync.ahead > 0
          ? `Send ${pluralize(sync.ahead, 'commit')} to ${sync.upstream}`
          : `Upload your local commits to ${sync.upstream}`
      case 'publish':
        return `Create ${branch} on ${remote} and start tracking it`
      case 'force-push':
        return `Careful — overwrites ${sync.upstream} with your history`
    }
  }

  // Glyph mirrors the menu's icon vocabulary so the pill and its popup never
  // disagree: Upload for sending (push/publish), Refresh for fetch (check the
  // remote, nothing merged), Download for pull (bring changes in).
  const glyph =
    running !== null ? (
      <span className="pill__chev is-spinning" style={{ display: 'flex' }}>
        <Icon.Refresh size={15} />
      </span>
    ) : primary === 'push' || primary === 'publish' ? (
      <Icon.Upload size={15} />
    ) : primary === 'fetch' ? (
      <Icon.Refresh size={15} />
    ) : (
      <Icon.Download size={15} />
    )

  // Each item carries a one-line explanation under its label — the same
  // title+sub pattern as the conflict-resolve menu — so the choice is clear
  // without reaching for the git docs. The sub comes from `describe` (shared
  // with the main button), and `tip` keeps the exact command on hover.
  const item = (action: SyncAction, icon: React.ReactNode, text: string, tip?: string) => (
    <button
      className="popover__item"
      data-tip={tip}
      onClick={() => {
        setOpen(false)
        if (action === 'force-push') setConfirmForce(true)
        else onAction(action)
      }}
    >
      <span className="icon-muted" style={{ display: 'flex' }}>
        {icon}
      </span>
      <span className="popover__item-main">
        <span className="popover__item-title">{text}</span>
        <span className="popover__item-sub">{describe(action)}</span>
      </span>
    </button>
  )

  return (
    <>
      <div className="sync">
        <button
          className="pill sync__main"
          disabled={busy}
          data-tip={describe(primary)}
          onClick={() => onAction(primary)}
        >
          {/* Determinate fill while the running action reports progress. */}
          {running !== null && progress !== null && (
            <span className="pill__fill" style={{ width: `${progress}%` }} aria-hidden="true" />
          )}
          <span className="pill__icon">{glyph}</span>
          <span className="pill__stack">
            <span className="pill__label">{label}</span>
            <span className="pill__sub">{sub}</span>
          </span>
          {sync.behind > 0 && <span className="sync-badge sync-badge--behind">{sync.behind}↓</span>}
          {sync.ahead > 0 && <span className="sync-badge sync-badge--ahead">{sync.ahead}↑</span>}
        </button>
        <button
          ref={anchor}
          className="pill sync__chev"
          disabled={busy}
          aria-label="More sync actions"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon.Chevron size={14} />
        </button>
      </div>

      <Popover
        anchor={anchor.current}
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        width={290}
      >
        <div className="popover__list">
          <div className="popover__group-label">Sync with {sync.remotes[0]}</div>
          {item('fetch', <Icon.Refresh size={15} />, 'Fetch', 'git fetch --prune')}
          {sync.upstream && item('pull', <Icon.Download size={15} />, 'Pull', 'git pull')}
          {sync.upstream &&
            item(
              'pull-rebase',
              // Branch glyph, not the download arrow: rebase reattaches your
              // commits onto a new base — distinct from a plain merging pull.
              <Icon.Branch size={15} />,
              'Pull with rebase',
              'git pull --rebase'
            )}
          {sync.upstream
            ? item('push', <Icon.Upload size={15} />, 'Push', 'git push')
            : item(
                'publish',
                <Icon.Upload size={15} />,
                'Publish branch',
                `push -u ${remote} ${branch}`
              )}
          {sync.upstream && (
            <>
              <div className="popover__sep" role="separator" />
              {item(
                'force-push',
                <Icon.Alert size={15} />,
                'Force push…',
                'git push --force-with-lease'
              )}
            </>
          )}
        </div>
      </Popover>

      {confirmForce && (
        <ConfirmDialog
          title="Force push?"
          danger
          body={
            <>
              This will overwrite <code>{sync.upstream}</code> with your local <code>{branch}</code>{' '}
              using <code>--force-with-lease</code>, which still refuses to clobber commits you
              haven't fetched. Anyone based on the old history will need to recover.
            </>
          }
          confirmLabel="Force push"
          onConfirm={() => {
            setConfirmForce(false)
            onAction('force-push')
          }}
          onCancel={() => setConfirmForce(false)}
        />
      )}
    </>
  )
}
