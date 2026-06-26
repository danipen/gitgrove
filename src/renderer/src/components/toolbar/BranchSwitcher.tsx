import { branchUrl, headPullRequestsUrl } from '@shared/git-host-urls'
import type { BranchInfo, PullRequestChecks, PullRequestInfo } from '@shared/types'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClearButton } from '@/components/common/ClearButton'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { Popover } from '@/components/common/Popover'
import { useVirtualScroll, VScrollbar } from '@/components/common/VirtualScroll'
import { type BranchRow, buildBranchRows } from '@/lib/branch-rows'
import { highlightMatch } from '@/lib/highlight'
import { Icon } from '@/lib/icons'
import type { BranchPrs } from '@/lib/pr-order'
import { useListKeyNav } from '@/lib/useListKeyNav'

/** Branch operations surfaced from the switcher (beyond plain checkout). */
export type BranchAction = 'new' | 'merge' | 'rename' | 'delete'

/** The CI rollup glyph inside a PR badge: a green check when passing, a red
 *  cross when failing, or a pulsing amber dot while checks are still running.
 *  styles: features/toolbar.css (.ci-status) */
function CiStatus({ state }: { state: PullRequestChecks }) {
  if (state === 'pending') return <span className="ci-status ci-status--pending" aria-hidden />
  return (
    <span className={`ci-status ci-status--${state}`} aria-hidden>
      {state === 'success' ? <Icon.Check size={10} /> : <Icon.Close size={10} />}
    </span>
  )
}

/** The leading state glyph for a PR, shared by the badge and the hovercard: the
 *  green/red/amber CI rollup for open PRs (nothing when no checks ran), or
 *  GitHub's merged/closed octicon (no CI dot — that CI is long settled). */
function PrGlyph({ pr }: { pr: PullRequestInfo }) {
  if (pr.state === 'open') return pr.checks ? <CiStatus state={pr.checks} /> : null
  return (
    <span className={`ci-status ci-status--${pr.state}`} aria-hidden>
      {pr.state === 'merged' ? <Icon.PrMerged size={11} /> : <Icon.PrClosed size={11} />}
    </span>
  )
}

/** The hovercard's leading state glyph: GitHub's open / merged / closed pull-
 *  request octicon, tinted by state (green / muted draft / purple / red). Unlike
 *  the badge's CI-rollup glyph, this always shows — it's the row's only state cue
 *  now that the text label is gone. */
function PrStateIcon({ pr }: { pr: PullRequestInfo }) {
  const state = pr.state === 'open' && pr.draft ? 'draft' : pr.state
  const Glyph =
    pr.state === 'merged' ? Icon.PrMerged : pr.state === 'closed' ? Icon.PrClosed : Icon.PrOpen
  return (
    <span className={`ci-status ci-status--${state}`} aria-hidden>
      <Glyph size={13} />
    </span>
  )
}

/** The `#123` pill marking a branch's most important PR: a state glyph + the
 *  number, tinted for merged (purple) / closed (red). One badge per branch — the
 *  full list (and count) lives in the hovercard. styles: features/toolbar.css */
function PrBadge({ pr }: { pr: PullRequestInfo }) {
  const stateClass =
    pr.state === 'merged' ? ' branch-pr--merged' : pr.state === 'closed' ? ' branch-pr--closed' : ''
  return (
    <span className={`branch-pr${stateClass}`}>
      <PrGlyph pr={pr} />#{pr.number}
    </span>
  )
}

/** A floating card listing a branch's PRs (icon, status, number, title) — shown
 *  on hover of the badge, always (one PR or many) so the UX is uniform. Each row
 *  is clickable to open the PR; when the branch has more PRs than were fetched
 *  (`total > prs.length`), a footer links to the full list on the host. Stays
 *  open while the pointer is in the badge↔card safe zone (see the tracking
 *  effect), so its rows are reachable across the gap. Portal-rendered so the
 *  popover / row overflow can't clip it; positioned under the badge, flipped
 *  above near the bottom edge. styles: features/toolbar.css */
function PrHoverCard({
  anchor,
  prs,
  total,
  githubWebUrl,
  keepOpen,
  requestClose,
  onActivate
}: {
  anchor: HTMLElement | null
  prs: PullRequestInfo[]
  total: number
  githubWebUrl?: string | null
  /** Pointer is inside the badge↔card safe zone — cancel any pending close. */
  keepOpen: () => void
  /** Pointer has left the safe zone — start the close countdown. */
  requestClose: () => void
  /** Called after opening a PR / the list, so the switcher can dismiss itself. */
  onActivate: () => void
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
    // Right-align to the badge (it sits at the row's trailing edge), clamped.
    let left = Math.min(r.right - card.width, window.innerWidth - card.width - m)
    left = Math.max(m, left)
    let top = r.bottom + gap
    if (top + card.height > window.innerHeight - m) top = r.top - gap - card.height
    top = Math.max(m, Math.min(top, window.innerHeight - card.height - m))
    setPos({ top, left })
  }, [anchor, prs])
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
  // More PRs exist than we fetched — offer the host's full, filtered list.
  const more = total > prs.length
  return createPortal(
    <div
      ref={ref}
      className="pr-card"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      <div className="pr-card__head">
        {total} pull request{total === 1 ? '' : 's'}
      </div>
      {prs.map((pr) => (
        // stopPropagation: the card is portal-rendered but lives in the branch
        // row's / pill's React subtree, so without it a click would also fire
        // their onClick and switch branch / toggle the popover.
        <button
          key={pr.number}
          type="button"
          className="pr-card__row"
          onClick={(e) => {
            e.stopPropagation()
            window.gitgrove.openExternal(pr.url)
            onActivate()
          }}
        >
          <span className="pr-card__glyph">
            <PrStateIcon pr={pr} />
          </span>
          <span className="pr-card__title">{pr.title}</span>
          <span className="pr-card__num">#{pr.number}</span>
          {/* The open affordance — makes it obvious the row opens in the browser. */}
          <Icon.External className="pr-card__open" size={12} />
        </button>
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

/** A branch's PR affordance: a single badge for its most important PR, with a
 *  hovercard (always, one PR or many) listing them all — clickable, counted, and
 *  with a "view all" link when the host has more than we fetched. Renders nothing
 *  when the branch has no PR. */
function BranchPrBadges({
  branchPrs,
  githubWebUrl,
  onActivate
}: {
  branchPrs: BranchPrs | undefined
  githubWebUrl?: string | null
  /** Called when a PR is opened, so the switcher popover can dismiss itself. */
  onActivate?: () => void
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const showT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Pointer is back in the badge↔card safe zone — cancel any pending close.
  const keepOpen = useCallback(() => {
    if (closeT.current) {
      clearTimeout(closeT.current)
      closeT.current = undefined
    }
  }, [])
  // Pointer has left the safe zone — close after a short grace. Scheduled once
  // (not reset on every move) so it still fires while the pointer keeps moving
  // away; keepOpen cancels it if the pointer returns in time.
  const requestClose = useCallback(() => {
    if (closeT.current) return
    closeT.current = setTimeout(() => {
      closeT.current = undefined
      setOpen(false)
    }, 200)
  }, [])
  if (!branchPrs || branchPrs.prs.length === 0) return null
  const { prs, total } = branchPrs
  const onBadgeEnter = () => {
    keepOpen() // cancel a close left from a quick out-and-back
    showT.current = setTimeout(() => setOpen(true), 120) // open after a short hover
  }
  // Only cancel a not-yet-open hover; once the card is open the tracking effect
  // owns the close, so we don't dismiss just because the pointer left the badge
  // (it's likely on its way into the card).
  const onBadgeLeave = () => clearTimeout(showT.current)
  // Opening a PR sends focus to the browser; tear the card (and switcher) down
  // so a stale, unfocused popover isn't left hanging behind it.
  const activate = () => {
    clearTimeout(showT.current)
    keepOpen()
    setOpen(false)
    onActivate?.()
  }
  return (
    // The empty data-tip swallows the row's branch-name tip while hovering the
    // badge, so only the rich hovercard shows.
    <span
      ref={ref}
      className="branch-prs"
      data-tip=""
      onMouseEnter={onBadgeEnter}
      onMouseLeave={onBadgeLeave}
    >
      <PrBadge pr={prs[0]} />
      {open && (
        <PrHoverCard
          anchor={ref.current}
          prs={prs}
          total={total}
          githubWebUrl={githubWebUrl}
          keepOpen={keepOpen}
          requestClose={requestClose}
          onActivate={activate}
        />
      )}
    </span>
  )
}

interface Props {
  branch: BranchInfo | null
  /** True while the full branch list is being fetched after a repo open. */
  loading?: boolean
  busy: boolean
  /** The repo's GitHub web base URL, when the host supports it — enables
   *  "View Branch on GitHub" for branches that exist on the remote. */
  githubWebUrl?: string | null
  /** Each branch's PRs (+ host total) keyed by head branch — drives the `#123`
   *  badge cluster (one badge + a `+N` overflow) and the "Open Pull Request"
   *  menu entries. */
  prByBranch?: Map<string, BranchPrs>
  /** Ask the host for PRs of the branches currently on screen. `revalidate`
   *  re-asks even cached ones (on open); without it, scrolling only fetches
   *  rows not looked up yet. Debounced here so a fast fling fires one request. */
  onNeedPrs?: (branches: string[], opts: { revalidate: boolean }) => void
  /** The checkout in flight: target branch + determinate progress (null while
   *  git hasn't reported any — fast switches never do). */
  switching?: { name: string; percent: number | null } | null
  onCheckout: (branch: string) => void
  /** When provided, enables the "New branch" footer and per-row context menu. */
  onBranchAction?: (action: BranchAction, branch: string) => void
  /** Called when the popover opens — the branch list is (re)loaded lazily. */
  onOpen?: () => void
}

/** A row's head-ref name for PR matching. A local row already is it; a remote
 *  row like `origin/foo` maps to `foo` — a remote branch is exactly what a PR's
 *  head ref names, so it's matched and fetched under the bare name. */
const headRef = (name: string, local: boolean) => (local ? name : name.slice(name.indexOf('/') + 1))

/** Cap a PR title so a submenu of them doesn't grow unboundedly wide. */
const truncate = (title: string, max = 52) =>
  title.length > max ? `${title.slice(0, max - 1)}…` : title

/** Fixed row height used by the virtualizer (must match the inline row height below). */
const ROW_H = 32
/** Empty space kept below the last row so it never sits flush against the edge. */
const PAD_BOTTOM = 8
/** Rows shown per popover viewport — also the PageUp/PageDown jump. */
const VIEW_ROWS = 12

export function BranchSwitcher({
  branch,
  loading = false,
  busy,
  githubWebUrl = null,
  prByBranch,
  onNeedPrs,
  switching = null,
  onCheckout,
  onBranchAction,
  onOpen
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  // Right-clicked branch row: cursor position + branch name. Local rows get
  // the full menu; remote rows just Copy (merge/rename/delete are local ops).
  const [menu, setMenu] = useState<{ x: number; y: number; name: string; local: boolean } | null>(
    null
  )
  // Right-click on the trigger pill: actions for the *current* branch.
  const [headMenu, setHeadMenu] = useState<{ x: number; y: number } | null>(null)

  const rows = useMemo<BranchRow[]>(() => buildBranchRows(branch, query), [branch, query])

  // Indexes of selectable rows (labels excluded) — the keyboard nav space.
  const itemRows = useMemo(() => rows.flatMap((row, i) => (row.kind === 'item' ? [i] : [])), [rows])

  // Main-thread scrolling via the shared scroller (see VirtualScroll.tsx for
  // the full rationale): native compositor scrolling would outrun the windowed
  // rows on fast flings and flash blank.
  const vs = useVirtualScroll({
    count: rows.length,
    rowHeight: ROW_H,
    padBottom: PAD_BOTTOM,
    initialViewportH: ROW_H * VIEW_ROWS
  })

  const select = (name: string) => {
    setOpen(false)
    setQuery('')
    if (name !== branch?.current) onCheckout(name)
  }

  // Arrows/Enter work the popover without touching the mouse: the filter
  // keeps focus (it autofocuses on open) while the highlight moves through
  // the virtualized rows. Suspended while a row's context menu is up so Enter
  // can't checkout underneath it.
  const nav = useListKeyNav({
    enabled: open && !menu,
    count: itemRows.length,
    page: VIEW_ROWS - 1,
    onActivate: (i) => {
      const row = rows[itemRows[i]]
      if (row?.kind === 'item') select(row.name)
    },
    // Enter on "No matching branches" runs the footer: create the typed name.
    onActivateEmpty: () => {
      const name = query.trim()
      if (!name || !onBranchAction) return
      setOpen(false)
      setQuery('')
      onBranchAction('new', name)
    },
    onHighlight: (i) => vs.ensureVisible(itemRows[i])
  })
  const kbdRow = itemRows[nav.index] ?? -1

  // Reset scroll + highlight when the result set changes or the popover opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query/open are intentional triggers; scrollTo/setIndex are stable.
  useEffect(() => {
    vs.scrollTo(0)
    nav.setIndex(0)
  }, [query, open])

  const visible = rows.slice(vs.start, vs.end)

  // A row's PRs, keyed by its head ref (remote rows map to their bare name).
  const prsForRow = (name: string, local: boolean): BranchPrs | undefined =>
    prByBranch?.get(headRef(name, local))

  // The head refs on screen (labels excluded; remote rows mapped to their bare
  // name, deduped) — the only PRs we ask for, so a 25k-branch repo queries a
  // viewport's worth, never the whole list.
  const visibleBranches = useMemo(() => {
    const refs = new Set<string>()
    for (const row of visible) {
      if (row.kind === 'item') refs.add(headRef(row.name, row.local))
    }
    return [...refs]
  }, [visible])
  // Keep the fetch callback in a ref so the effects below key off the viewport
  // changing, not the (inline) callback's identity.
  const needPrsRef = useRef(onNeedPrs)
  needPrsRef.current = onNeedPrs

  // On open, revalidate the viewport's PRs: the cache paints badges instantly,
  // this refreshes them in case CI/state moved while the popover was closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open is the trigger; the viewport is read at open time and the scroll effect below tracks its later changes.
  useEffect(() => {
    if (open) needPrsRef.current?.(visibleBranches, { revalidate: true })
  }, [open])

  // As scrolling/filtering reveals new rows, fetch their PRs once motion settles
  // (debounced). Cached branches are skipped by the caller, so flinging back
  // over already-seen rows costs nothing and a fast fling fires one request.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      needPrsRef.current?.(visibleBranches, { revalidate: false })
    }, 200)
    return () => clearTimeout(timer)
  }, [open, visibleBranches])

  // A local branch is browsable on the host only once it exists on a remote;
  // `branch.remote` holds entries like `origin/feature/x`, so comparing the
  // part after the remote name avoids offering a link that would 404.
  const isPublished = (name: string) =>
    branch?.remote.some((r) => r.slice(r.indexOf('/') + 1) === name) ?? false

  /** The GitHub group for a branch's menu, under a single leading separator (or
   *  nothing when none apply): one "Open Pull Request #N" entry when the branch
   *  has a single PR, or a "Pull Requests (N)" submenu listing them (plus a "View
   *  all on GitHub" entry when the host has more than we fetched) when it has
   *  several — so the menu never spills 10 rows. Then "View Branch on GitHub"
   *  when the branch is published. */
  const githubMenuItems = (name: string): ContextMenuItem[] => {
    const entry = prByBranch?.get(name)
    const prs = entry?.prs ?? []
    const total = entry?.total ?? prs.length
    const items: ContextMenuItem[] = []

    if (total === 1 && prs.length === 1) {
      const pr = prs[0]
      items.push({
        label: `Open Pull Request #${pr.number}${pr.state === 'open' ? '' : ` (${pr.state})`}`,
        icon: <Icon.Github size={15} />,
        onClick: () => window.gitgrove.openExternal(pr.url)
      })
    } else if (prs.length > 0) {
      const submenu: ContextMenuItem[] = prs.map((pr) => ({
        label: `#${pr.number} ${truncate(pr.title)}${pr.state === 'open' ? '' : ` (${pr.state})`}`,
        icon: <Icon.Github size={15} />,
        onClick: () => window.gitgrove.openExternal(pr.url)
      }))
      if (githubWebUrl && total > prs.length) {
        const web = githubWebUrl
        submenu.push(
          {},
          {
            label: `View all ${total} on GitHub`,
            icon: <Icon.External size={15} />,
            onClick: () => window.gitgrove.openExternal(headPullRequestsUrl(web, name))
          }
        )
      }
      items.push({ label: `Pull Requests (${total})`, icon: <Icon.Github size={15} />, submenu })
    }

    if (githubWebUrl && isPublished(name)) {
      items.push({
        label: 'View Branch on GitHub',
        icon: <Icon.Github size={15} />,
        onClick: () => window.gitgrove.openExternal(branchUrl(githubWebUrl, name))
      })
    }
    return items.length > 0 ? [{}, ...items] : []
  }

  /** The full context menu for a local branch row. */
  const localBranchMenuItems = (name: string) => {
    if (!onBranchAction) return []
    return [
      {
        label: 'Checkout',
        icon: <Icon.Check size={15} />,
        disabled: name === branch?.current,
        onClick: () => {
          setOpen(false)
          select(name)
        }
      },
      {},
      {
        // The single entry point for bringing a branch in: the dialog offers
        // merge, squash AND rebase, each explained, with a conflict preview —
        // a bare "rebase onto this" item would duplicate it minus the safety.
        label: `Merge into ${branch?.current ?? 'current'}…`,
        icon: <Icon.Merge size={15} />,
        disabled: name === branch?.current,
        onClick: () => {
          setOpen(false)
          onBranchAction('merge', name)
        }
      },
      {},
      {
        label: 'Rename…',
        icon: <Icon.Pencil size={15} />,
        onClick: () => {
          setOpen(false)
          onBranchAction('rename', name)
        }
      },
      {
        label: 'Delete…',
        icon: <Icon.Trash size={15} />,
        danger: true,
        disabled: name === branch?.current,
        onClick: () => {
          setOpen(false)
          onBranchAction('delete', name)
        }
      },
      {},
      {
        label: 'Copy Branch Name',
        icon: <Icon.Copy size={15} />,
        onClick: () => window.gitgrove.clipboardWrite(name)
      },
      ...githubMenuItems(name)
    ]
  }

  const label = switching
    ? switching.name
    : branch
      ? branch.detached
        ? `detached @ ${branch.current.slice(0, 7)}`
        : branch.current
      : '—'

  // The current branch's PRs, for the pill's badge cluster (hidden mid-switch
  // and on a detached HEAD, which has no branch to match; none on the default
  // branch, per prsForRow).
  const headPrs =
    !switching && !branch?.detached ? prsForRow(branch?.current ?? '', true) : undefined

  return (
    <>
      <button
        ref={anchor}
        className="pill"
        disabled={!branch || busy || loading}
        title={
          loading ? 'Loading branches…' : switching ? `Switching to ${switching.name}…` : undefined
        }
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          // Open fresh: a filter left over from the last open (or another repo)
          // shouldn't pre-narrow the list — like the repo switcher, every open
          // starts empty.
          setQuery('')
          onOpen?.()
          setOpen(true)
        }}
        onContextMenu={
          branch && !branch.detached && onBranchAction && !switching
            ? (e) => {
                e.preventDefault()
                setHeadMenu({ x: e.clientX, y: e.clientY })
              }
            : undefined
        }
      >
        {/* Determinate fill while a checkout updates the working tree. */}
        {switching && switching.percent !== null && (
          <span
            className="pill__fill"
            style={{ width: `${switching.percent}%` }}
            aria-hidden="true"
          />
        )}
        <span className="pill__icon">
          <Icon.Branch size={16} />
        </span>
        <span className="pill__stack">
          <span className="pill__caption">Branch</span>
          {/* Show the full branch name on hover only when it's been ellipsized. */}
          <span className="pill__label" data-tip={label} data-tip-overflow="">
            {label}
          </span>
        </span>
        <BranchPrBadges
          branchPrs={headPrs}
          githubWebUrl={githubWebUrl}
          onActivate={() => setOpen(false)}
        />
        <span className={`pill__chev${loading || switching ? ' is-spinning' : ''}`}>
          {loading || switching ? <Icon.Refresh size={14} /> : <Icon.Chevron size={14} />}
        </span>
      </button>

      <Popover anchor={anchor.current} open={open} onClose={() => setOpen(false)} width={340}>
        <div className="popover__search">
          <input
            data-autofocus=""
            placeholder="Switch branch…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query !== '' && <ClearButton label="Clear filter" onClear={() => setQuery('')} />}
        </div>
        {rows.length === 0 ? (
          <div className="popover__empty">No matching branches</div>
        ) : (
          <div className="popover__list" ref={vs.viewportRef}>
            <div className="vlist__sizer" style={{ height: vs.totalHeight }} aria-hidden="true" />
            <div className="vlist__content" style={{ transform: `translateY(${-vs.top}px)` }}>
              {visible.map((row, i) => {
                const index = vs.start + i
                const rowStyle = {
                  position: 'absolute' as const,
                  top: vs.rowTop(index),
                  left: 0,
                  right: 0,
                  height: ROW_H,
                  boxSizing: 'border-box' as const
                }
                if (row.kind === 'label') {
                  return (
                    <div key={row.key} className="popover__group-label" style={rowStyle}>
                      {row.text}
                    </div>
                  )
                }
                return (
                  <button
                    key={row.key}
                    className={`popover__item${row.current ? ' is-active' : ''}${
                      index === kbdRow ? ' is-kbd' : ''
                    }${menu?.name === row.name && menu?.local === row.local ? ' is-context' : ''}`}
                    style={rowStyle}
                    data-tip={row.name}
                    data-tip-overflow=""
                    onClick={() => select(row.name)}
                    onContextMenu={
                      onBranchAction
                        ? (e) => {
                            e.preventDefault()
                            setMenu({
                              x: e.clientX,
                              y: e.clientY,
                              name: row.name,
                              local: row.local
                            })
                          }
                        : undefined
                    }
                  >
                    <span className="icon-muted branch-glyph" aria-hidden="true" />
                    <span className="popover__item-main">
                      <span className="popover__item-title">{highlightMatch(row.name, query)}</span>
                    </span>
                    <BranchPrBadges
                      branchPrs={prsForRow(row.name, row.local)}
                      githubWebUrl={githubWebUrl}
                      onActivate={() => setOpen(false)}
                    />
                    {row.current && <span className="tag tag--current">current</span>}
                  </button>
                )
              })}
            </div>
            <VScrollbar vs={vs} />
          </div>
        )}
        {onBranchAction && (
          <div className="popover__footer">
            <button
              // Highlighted when the list is empty — Enter runs this footer.
              className={`popover__item popover__item--footer${
                rows.length === 0 && query.trim() ? ' is-kbd' : ''
              }`}
              onClick={() => {
                setOpen(false)
                setQuery('')
                onBranchAction('new', query.trim())
              }}
            >
              <span className="icon-muted" style={{ display: 'flex' }}>
                <Icon.Plus size={15} />
              </span>
              <span className="popover__item-main">
                <span className="popover__item-title">
                  {query.trim() ? `New branch “${query.trim()}”…` : 'New branch…'}
                </span>
              </span>
            </button>
          </div>
        )}
      </Popover>

      {headMenu && branch && onBranchAction && (
        <ContextMenu
          x={headMenu.x}
          y={headMenu.y}
          onClose={() => setHeadMenu(null)}
          items={[
            {
              label: 'Copy Branch Name',
              icon: <Icon.Copy size={15} />,
              onClick: () => window.gitgrove.clipboardWrite(branch.current)
            },
            {},
            {
              label: 'New Branch…',
              icon: <Icon.Plus size={15} />,
              onClick: () => onBranchAction('new', '')
            },
            {
              label: 'Rename…',
              icon: <Icon.Pencil size={15} />,
              onClick: () => onBranchAction('rename', branch.current)
            },
            ...githubMenuItems(branch.current)
          ]}
        />
      )}

      {menu && onBranchAction && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.local
              ? localBranchMenuItems(menu.name)
              : [
                  {
                    label: 'Copy Branch Name',
                    icon: <Icon.Copy size={15} />,
                    onClick: () => window.gitgrove.clipboardWrite(menu.name)
                  },
                  // A remote row matches PRs by its bare ref, so its menu links to
                  // them (and to the branch on the host) just like a local one.
                  ...githubMenuItems(headRef(menu.name, false))
                ]
          }
        />
      )}
    </>
  )
}
