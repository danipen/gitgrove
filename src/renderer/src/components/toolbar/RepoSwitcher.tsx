import type { RecentRepo, RepoInfo, RepoSummary } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { Popover } from '@/components/common/Popover'
import { Toast } from '@/components/common/Toast'
import { prettyPath } from '@/lib/format'
import { highlightMatch } from '@/lib/highlight'
import { Icon } from '@/lib/icons'
import { isGithubUrl, remoteLabel, revealLabel } from '@/lib/repo-actions'
import { useListKeyNav } from '@/lib/useListKeyNav'

/** One rendered line of the popover: a section label or a repository row. */
type Row =
  | { kind: 'label'; key: string; text: string }
  | { kind: 'repo'; key: string; repo: RecentRepo }

interface Props {
  repo: RepoSummary | null
  onOpenRepo: (path: string) => void
  onPickRepo: () => void
}

/** A right-click target: where to anchor the menu, which repo, and whether it's
 *  a recent-list row (so the menu can offer "Remove from Recents"). */
interface MenuState {
  x: number
  y: number
  repo: RepoInfo
  isRecent: boolean
  /** The right-clicked row's key, so that exact row can stay lit while the menu
   *  is open. Absent when the menu was raised from the trigger pill. */
  key?: string
  /** Resolved remote web URL, or null when the repo has no browsable remote. */
  remote: string | null
}

/** Past this many known repos the popover gains a filter + Recent/All split. */
const RECENT_TOP = 5

export function RepoSwitcher({ repo, onOpenRepo, onPickRepo }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<RecentRepo[]>([])
  const [menu, setMenu] = useState<MenuState | null>(null)
  // `id` keys the rendered Toast so re-flashing the same message (e.g. "Open in
  // Terminal" failing twice in a row) remounts it and restarts its countdown.
  const [notice, setNotice] = useState<{ message: string; ok: boolean; id: number } | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const noticeSeq = useRef(0)

  useEffect(() => {
    if (open) window.gitgrove.recentRepos().then(setRecents)
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  // `recentRepos` returns every known repo, newest first. Once the list is long
  // enough to be awkward to eyeball we offer a filter and a Recent/All split:
  // the handful of newest on top, then the rest alphabetically — a repo already
  // shown under Recent isn't repeated below, so every repo appears exactly once.
  const grouped = recents.length > RECENT_TOP
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!q) return recents
    return recents.filter(
      (r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)
    )
  }, [recents, q])
  const allSorted = useMemo(
    () => [...matches].sort((a, b) => a.name.localeCompare(b.name)),
    [matches]
  )

  // Flat row model (labels + repos) so rendering and keyboard navigation share
  // one source of truth. Keys carry the section prefix so they stay unique and
  // stable as the filter narrows the list.
  const rows = useMemo<Row[]>(() => {
    const label = (text: string): Row => ({ kind: 'label', key: `label-${text}`, text })
    const repoRow = (section: string, r: RecentRepo): Row => ({
      kind: 'repo',
      key: `${section}:${r.path}`,
      repo: r
    })
    if (matches.length === 0) return []
    if (grouped && !q) {
      // All lists everything *except* the repos already up under Recent — no
      // repo is shown twice.
      const top = recents.slice(0, RECENT_TOP)
      const topPaths = new Set(top.map((r) => r.path))
      const rest = allSorted.filter((r) => !topPaths.has(r.path))
      return [
        label('Recent'),
        ...top.map((r) => repoRow('recent', r)),
        label('All'),
        ...rest.map((r) => repoRow('all', r))
      ]
    }
    return [...(q ? [] : [label('Recent')]), ...matches.map((r) => repoRow('recent', r))]
  }, [recents, matches, allSorted, grouped, q])

  /** Indexes of repo rows (labels excluded) — the keyboard nav space. */
  const itemRows = useMemo(() => rows.flatMap((row, i) => (row.kind === 'repo' ? [i] : [])), [rows])

  const listRef = useRef<HTMLDivElement>(null)

  // Arrows/Enter work the popover without the mouse; the filter (when shown)
  // keeps focus so typing and navigating interleave freely. Suspended while a
  // row's context menu is up so Enter can't open a repo underneath it.
  const nav = useListKeyNav({
    enabled: open && !menu,
    count: itemRows.length,
    onActivate: (i) => {
      const row = rows[itemRows[i]]
      if (row?.kind === 'repo') {
        close()
        onOpenRepo(row.repo.path)
      }
    },
    onHighlight: (i) => {
      // Rows are natively scrolled (no virtualization) — nudge the highlighted
      // one into view. Labels aren't .popover__item, so nth-of-item matches i.
      listRef.current?.querySelectorAll('.popover__item')[i]?.scrollIntoView({ block: 'nearest' })
    }
  })
  const kbdRow = itemRows[nav.index] ?? -1

  // Typing a new filter restarts the highlight at the first match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the intentional trigger; setIndex is stable.
  useEffect(() => nav.setIndex(0), [q])

  const flash = (message: string, ok = true) => {
    noticeSeq.current += 1
    setNotice({ message, ok, id: noticeSeq.current })
  }

  const removeRecent = async (path: string) => {
    setRecents(await window.gitgrove.removeRecent(path))
  }

  // Resolve the repo's remote before showing the menu so its items don't reflow
  // mid-open; the cursor point is captured up front since the event is reused.
  const openMenu = async (
    e: React.MouseEvent,
    target: RepoInfo,
    isRecent: boolean,
    key?: string
  ) => {
    e.preventDefault()
    const { clientX, clientY } = e
    const remote = await window.gitgrove.remoteUrl(target.path).catch(() => null)
    setMenu({ x: clientX, y: clientY, repo: target, isRecent, key, remote })
  }

  const buildItems = (m: MenuState): ContextMenuItem[] => {
    const { repo: target, isRecent, remote } = m
    const items: ContextMenuItem[] = [
      {
        label: 'Copy Repo Name',
        icon: <Icon.Copy size={15} />,
        onClick: () => window.gitgrove.clipboardWrite(target.name)
      },
      {
        label: 'Copy Repo Path',
        icon: <Icon.Copy size={15} />,
        onClick: () => window.gitgrove.clipboardWrite(target.path)
      },
      {}
    ]
    if (remote) {
      items.push({
        label: remoteLabel(remote),
        icon: isGithubUrl(remote) ? <Icon.Github size={15} /> : <Icon.External size={15} />,
        onClick: () => window.gitgrove.openExternal(remote)
      })
    }
    items.push(
      {
        label: revealLabel,
        icon: <Icon.Folder size={15} />,
        onClick: async () => {
          if (!(await window.gitgrove.revealRepo(target.path)))
            flash('Could not open the folder', false)
        }
      },
      {
        label: 'Open in Terminal',
        icon: <Icon.Terminal size={15} />,
        onClick: async () => {
          if (!(await window.gitgrove.openTerminal(target.path)))
            flash('No terminal application found', false)
        }
      }
    )
    if (isRecent) {
      items.push(
        {},
        {
          label: 'Remove from Recents',
          icon: <Icon.Trash size={15} />,
          danger: true,
          onClick: () => removeRecent(target.path)
        }
      )
    }
    return items
  }

  const renderRow = (key: string, r: RecentRepo, kbd: boolean) => (
    <button
      key={key}
      className={`popover__item${repo?.path === r.path ? ' is-active' : ''}${kbd ? ' is-kbd' : ''}${
        menu?.key === key ? ' is-context' : ''
      }`}
      onClick={() => {
        close()
        onOpenRepo(r.path)
      }}
      onContextMenu={(e) => openMenu(e, r, true, key)}
    >
      <span className="icon-muted">
        <Icon.Repo size={15} />
      </span>
      <span className="popover__item-main">
        <span className="popover__item-title">{highlightMatch(r.name, query)}</span>
        <span className="popover__item-sub">{highlightMatch(prettyPath(r.path), query)}</span>
      </span>
      <span
        className="popover__item-remove"
        title="Remove from recents"
        onClick={(e) => {
          e.stopPropagation()
          removeRecent(r.path)
        }}
      >
        <Icon.Close size={13} />
      </span>
    </button>
  )

  return (
    <>
      <button
        ref={anchor}
        className="pill"
        data-tip={repo?.path}
        onClick={() => (open ? close() : setOpen(true))}
        onContextMenu={repo ? (e) => openMenu(e, repo, false) : undefined}
      >
        <span className="pill__icon">
          <Icon.Repo size={16} />
        </span>
        <span className="pill__stack">
          <span className="pill__caption">Repository</span>
          <span className="pill__label">{repo ? repo.name : 'Open repository'}</span>
        </span>
        <span className="pill__chev">
          <Icon.Chevron size={14} />
        </span>
      </button>

      <Popover anchor={anchor.current} open={open} onClose={close} width={340}>
        {grouped && (
          <div className="popover__search">
            <input
              data-autofocus=""
              placeholder="Filter repositories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        <div className="repo-list" ref={listRef}>
          {recents.length === 0 ? (
            <div className="popover__empty">No recent repositories</div>
          ) : rows.length === 0 ? (
            <div className="popover__empty">No matching repositories</div>
          ) : (
            rows.map((row, i) =>
              row.kind === 'label' ? (
                <div key={row.key} className="popover__group-label">
                  {row.text}
                </div>
              ) : (
                renderRow(row.key, row.repo, i === kbdRow)
              )
            )
          )}
        </div>
        <div className="popover__footer">
          <button
            className="btn-ghost"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => {
              close()
              onPickRepo()
            }}
          >
            <Icon.Folder size={15} /> Open another repository…
          </button>
        </div>
      </Popover>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={buildItems(menu)} onClose={() => setMenu(null)} />
      )}

      {notice &&
        createPortal(
          <Toast
            key={notice.id}
            kind={notice.ok ? 'success' : 'error'}
            message={notice.message}
            onClose={() => setNotice(null)}
            durationMs={2200}
          />,
          document.body
        )}
    </>
  )
}
