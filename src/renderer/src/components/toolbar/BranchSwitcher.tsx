import { branchPullsUrl, branchUrl } from '@shared/git-host-urls'
import type { BranchInfo, PullRequestChecks, PullRequestInfo } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ClearButton } from '@/components/common/ClearButton'
import { ContextMenu } from '@/components/common/ContextMenu'
import { Popover } from '@/components/common/Popover'
import { useVirtualScroll, VScrollbar } from '@/components/common/VirtualScroll'
import { type BranchRow, buildBranchRows } from '@/lib/branch-rows'
import { highlightMatch } from '@/lib/highlight'
import { Icon } from '@/lib/icons'
import { useListKeyNav } from '@/lib/useListKeyNav'

/** Branch operations surfaced from the switcher (beyond plain checkout). */
export type BranchAction = 'new' | 'merge' | 'rename' | 'delete'

/** Tooltip wording for each CI rollup state, appended to the PR badge's tip. */
const CHECKS_LABEL: Record<PullRequestChecks, string> = {
  success: 'checks passing',
  failure: 'checks failing',
  pending: 'checks running'
}

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

interface Props {
  branch: BranchInfo | null
  /** True while the full branch list is being fetched after a repo open. */
  loading?: boolean
  busy: boolean
  /** The repo's GitHub web base URL, when the host supports it — enables
   *  "View Branch on GitHub" for branches that exist on the remote. */
  githubWebUrl?: string | null
  /** Open PRs keyed by head branch — drives the `#123` badge and "Open PR". */
  prByBranch?: Map<string, PullRequestInfo>
  /** The checkout in flight: target branch + determinate progress (null while
   *  git hasn't reported any — fast switches never do). */
  switching?: { name: string; percent: number | null } | null
  onCheckout: (branch: string) => void
  /** When provided, enables the "New branch" footer and per-row context menu. */
  onBranchAction?: (action: BranchAction, branch: string) => void
  /** Called when the popover opens — the branch list is (re)loaded lazily. */
  onOpen?: () => void
}

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

  // A local branch is browsable on the host only once it exists on a remote;
  // `branch.remote` holds entries like `origin/feature/x`, so comparing the
  // part after the remote name avoids offering a link that would 404.
  const isPublished = (name: string) =>
    branch?.remote.some((r) => r.slice(r.indexOf('/') + 1) === name) ?? false

  /** The GitHub group for a branch's menu, under a single leading separator (or
   *  nothing when none apply): "Open Pull Request #N" when an open PR exists,
   *  else "View Pull Requests on GitHub" for a published branch (which also
   *  surfaces merged/closed PRs), plus "View Branch on GitHub". */
  const githubMenuItems = (name: string) => {
    const items = []
    const pr = prByBranch?.get(name)
    const published = !!githubWebUrl && isPublished(name)
    if (pr) {
      items.push({
        label: `Open Pull Request #${pr.number}`,
        icon: <Icon.Github size={15} />,
        onClick: () => window.gitgrove.openExternal(pr.url)
      })
    } else if (published && githubWebUrl) {
      // No open PR — link to the branch's PR list, which spans merged/closed too.
      items.push({
        label: 'View Pull Requests on GitHub',
        icon: <Icon.Github size={15} />,
        onClick: () => window.gitgrove.openExternal(branchPullsUrl(githubWebUrl, name))
      })
    }
    if (published && githubWebUrl) {
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

  // The `#123` pill marking a branch that has an open PR (dimmed for drafts),
  // with the CI rollup glyph when checks have run.
  // styles: features/toolbar.css (.branch-pr)
  const renderPrBadge = (pr: PullRequestInfo | undefined) => {
    if (!pr) return null
    const kind = pr.draft ? 'Draft PR' : 'PR'
    const checks = pr.checks ? ` — ${CHECKS_LABEL[pr.checks]}` : ''
    return (
      <span
        className={`branch-pr${pr.draft ? ' branch-pr--draft' : ''}`}
        data-tip={`${kind} #${pr.number}: ${pr.title}${checks}`}
      >
        {pr.checks && <CiStatus state={pr.checks} />}#{pr.number}
      </span>
    )
  }
  const headPr =
    !switching && !branch?.detached ? prByBranch?.get(branch?.current ?? '') : undefined

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
          setOpen((v) => {
            if (!v) onOpen?.()
            return !v
          })
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
        {renderPrBadge(headPr)}
        <span className={`pill__chev${loading || switching ? ' is-spinning' : ''}`}>
          {loading || switching ? <Icon.Refresh size={14} /> : <Icon.Chevron size={14} />}
        </span>
      </button>

      <Popover anchor={anchor.current} open={open} onClose={() => setOpen(false)} width={300}>
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
                    {renderPrBadge(prByBranch?.get(row.name))}
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
                  }
                ]
          }
        />
      )}
    </>
  )
}
