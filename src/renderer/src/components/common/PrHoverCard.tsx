// The pull-request hovercard and the PR state glyphs, shared by every place a
// branch shows its PR: the branch switcher's `#123` badge (toolbar) and the
// Graph's label chips. One card, so a PR reads the same wherever it's found.
// styles: primitives.css (.pr-card, .ci-status)

import { headPullRequestsUrl } from '@shared/git-host-urls'
import type { PullRequestChecks, PullRequestInfo } from '@shared/types'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/lib/icons'

/** What the card positions against and tracks the pointer around: a DOM
 *  badge, or a canvas-drawn chip standing in with its on-screen rect. */
export interface PrCardAnchor {
  getBoundingClientRect(): DOMRect
}

/** The CI rollup glyph inside a PR badge: a green check when passing, a red
 *  cross when failing, or a pulsing amber dot while checks are still running.
 *  styles: primitives.css (.ci-status) */
function CiStatus({ state }: { state: PullRequestChecks }) {
  if (state === 'pending') return <span className="ci-status ci-status--pending" aria-hidden />
  return (
    <span className={`ci-status ci-status--${state}`} aria-hidden>
      {state === 'success' ? <Icon.Check size={10} /> : <Icon.Close size={10} />}
    </span>
  )
}

/** The leading state glyph for a PR's badge: the green/red/amber CI rollup
 *  for an open PR; with no checks yet, GitHub's draft octicon for a draft (a
 *  ready PR shows nothing); or the merged/closed octicon once it settles (no
 *  CI — that is long settled). The Graph's label chips follow the same rule
 *  (graph/prChip.ts prChipGlyph). */
export function PrGlyph({ pr }: { pr: PullRequestInfo }) {
  if (pr.state === 'open') {
    if (pr.checks) return <CiStatus state={pr.checks} />
    return pr.draft ? <PrStateIcon pr={pr} size={11} /> : null
  }
  return (
    <span className={`ci-status ci-status--${pr.state}`} aria-hidden>
      {pr.state === 'merged' ? <Icon.PrMerged size={11} /> : <Icon.PrClosed size={11} />}
    </span>
  )
}

const STATE_OCTICON = {
  open: Icon.PrOpen,
  draft: Icon.PrDraft,
  merged: Icon.PrMerged,
  closed: Icon.PrClosed
}

/** A PR's state octicon — open / draft / merged / closed, tinted by state
 *  (green / muted / purple / red), exactly as github.com draws them. The
 *  hovercard rows lead with it (always: it's the row's only state cue); the
 *  badge borrows the draft one. */
function PrStateIcon({ pr, size = 13 }: { pr: PullRequestInfo; size?: number }) {
  const state = pr.state === 'open' && pr.draft ? 'draft' : pr.state
  const Glyph = STATE_OCTICON[state]
  return (
    <span className={`ci-status ci-status--${state}`} aria-hidden>
      <Glyph size={size} />
    </span>
  )
}

/** One pull request as a link row — state octicon, title, number, and the
 *  "opens in the browser" cue; clicking opens it on the host. The card's rows,
 *  and the Graph detail pane's PR list. `onOpen` runs after the link opens. */
export function PrRow({
  pr,
  compact = false,
  onOpen
}: {
  pr: PullRequestInfo
  /** Name the PR by number only — where its title is already on screen. */
  compact?: boolean
  onOpen?: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      className="pr-card__row"
      onClick={(e) => {
        window.gitgrove.openExternal(pr.url)
        onOpen?.(e)
      }}
    >
      <span className="pr-card__glyph">
        <PrStateIcon pr={pr} />
      </span>
      <span className="pr-card__title">{compact ? `Pull request #${pr.number}` : pr.title}</span>
      {!compact && <span className="pr-card__num">#{pr.number}</span>}
      {/* The open affordance — makes it obvious the row opens in the browser. */}
      <Icon.External className="pr-card__open" size={12} />
    </button>
  )
}

/** A floating card listing a branch's PRs (icon, status, number, title) — shown
 *  on hover of the badge, always (one PR or many) so the UX is uniform. Each row
 *  is clickable to open the PR; when the branch has more PRs than were fetched
 *  (`total > prs.length`), a footer links to the full list on the host. Stays
 *  open while the pointer is in the badge↔card safe zone (see the tracking
 *  effect), so its rows are reachable across the gap. Portal-rendered so the
 *  popover / row overflow can't clip it; positioned under the badge, flipped
 *  above near the bottom edge. styles: primitives.css */
export function PrHoverCard({
  anchor,
  prs,
  total,
  githubWebUrl,
  keepOpen,
  requestClose,
  dismiss,
  onActivate,
  align = 'end'
}: {
  anchor: PrCardAnchor | null
  prs: PullRequestInfo[]
  total: number
  githubWebUrl?: string | null
  /** Pointer is inside the badge↔card safe zone — cancel any pending close. */
  keepOpen: () => void
  /** Pointer has left the safe zone — start the close countdown. */
  requestClose: () => void
  /** Close just the card (leaving the switcher popover open) — Escape. */
  dismiss: () => void
  /** Called after opening a PR / the list, so the switcher can dismiss itself. */
  onActivate: () => void
  /** Which anchor edge the card lines up with: `end` (right) for a badge at a
   *  row's trailing edge, `start` (left) for a chip read left-to-right. */
  align?: 'start' | 'end'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: prs changes the measured height
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const r = anchor.getBoundingClientRect()
    const card = ref.current.getBoundingClientRect()
    const m = 8 // viewport-edge margin
    const gap = 6 // space between the badge and the card
    // Line up with the anchor's chosen edge, clamped to the viewport.
    const edge = align === 'start' ? r.left : r.right - card.width
    let left = Math.min(edge, window.innerWidth - card.width - m)
    left = Math.max(m, left)
    let top = r.bottom + gap
    if (top + card.height > window.innerHeight - m) top = r.top - gap - card.height
    top = Math.max(m, Math.min(top, window.innerHeight - card.height - m))
    setPos({ top, left })
  }, [anchor, prs, align])
  // Keep the card open while the pointer is anywhere in the "safe zone" — the
  // badge, the card, or the full-width corridor between them — and close once it
  // has left that zone. The badge is small and sits at the card's trailing edge
  // while the card is wide and drops to its left, so the pointer travels a
  // diagonal to reach a row; tracking the live position (rather than relying on
  // mouseenter/leave across the two elements and the gap between them) means no
  // travel path, gap, or React-portal event-ordering can dismiss it mid-journey.
  useEffect(() => {
    const card = ref.current
    if (!anchor || !card) return
    const onMove = (e: PointerEvent) => {
      const a = anchor.getBoundingClientRect()
      const c = card.getBoundingClientRect()
      const { clientX: x, clientY: y } = e
      const pad = 6 // sub-pixel + a little slack so a grazing path still counts
      const inRect = (rect: DOMRect) =>
        x >= rect.left - pad &&
        x <= rect.right + pad &&
        y >= rect.top - pad &&
        y <= rect.bottom + pad
      // The corridor spans the card's full width across the gap between the two,
      // so any descent into the card crosses it instead of a dead patch (works
      // whether the card sits below the badge or, when flipped, above it).
      const inCorridor =
        x >= c.left - pad &&
        x <= c.right + pad &&
        y >= Math.min(a.bottom, c.bottom) - pad &&
        y <= Math.max(a.top, c.top) + pad
      if (inRect(a) || inRect(c) || inCorridor) keepOpen()
      else requestClose()
    }
    document.addEventListener('pointermove', onMove)
    return () => document.removeEventListener('pointermove', onMove)
  }, [anchor, keepOpen, requestClose])
  // Escape peels just the card, leaving the switcher popover open (a second
  // Escape then closes that). Capture-phase + stopPropagation so the popover's
  // own window-level Escape doesn't also fire — same layering as ContextMenu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dismiss])
  // More PRs exist than we fetched — offer the host's full, filtered list.
  const more = total > prs.length
  return createPortal(
    <div
      ref={ref}
      className="pr-card"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
      // The card is portal-rendered but lives in the branch row's React subtree,
      // so a right-click would bubble to the row's onContextMenu and open the
      // branch menu behind it. Swallow it — the card has no menu of its own.
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="pr-card__head">
        {total} pull request{total === 1 ? '' : 's'}
      </div>
      {prs.map((pr) => (
        // stopPropagation: the card is portal-rendered but lives in the branch
        // row's / pill's React subtree, so without it a click would also fire
        // their onClick and switch branch / toggle the popover.
        <PrRow
          key={pr.number}
          pr={pr}
          onOpen={(e) => {
            e.stopPropagation()
            onActivate()
          }}
        />
      ))}
      {more && githubWebUrl && (
        <button
          type="button"
          className="pr-card__more"
          onClick={(e) => {
            e.stopPropagation()
            window.gitgrove.openExternal(headPullRequestsUrl(githubWebUrl, prs[0].headBranch))
            onActivate()
          }}
        >
          View all {total} on GitHub
          <Icon.External size={12} />
        </button>
      )}
    </div>,
    document.body
  )
}
