// One command-palette result: a kind glyph, the highlighted title (and
// subtitle), a trailing badge or shortcut hint, and — for results with
// actions — a "⋯" button that opens the same menu as a right-click.
// styles: styles/features/palette.css

import type { ReactNode } from 'react'
import { Shortcut } from '@/components/common/Shortcut'
import { splitPath, statusLabel, statusLetter } from '@/lib/format'
import { highlightPositions } from '@/lib/highlight'
import { Icon } from '@/lib/icons'
import type { PaletteHit } from './paletteResults'

interface Props {
  hit: PaletteHit
  /** Index in the palette's keyboard order (`data-entry`, for scrolling). */
  entry: number
  selected: boolean
  /** This row's menu is open (keeps it highlighted like the switchers do). */
  menuOpen: boolean
  hasMenu: boolean
  onHover: () => void
  onActivate: () => void
  /** Open the row's menu at a point (right-click) or hung from the ⋯ button. */
  onMenu: (at: { x: number; y: number } | DOMRect) => void
}

function glyph(hit: PaletteHit): ReactNode {
  const { item } = hit
  switch (item.kind) {
    case 'command':
      return <Icon.Terminal size={15} />
    case 'branch':
      return <span className="branch-glyph" />
    case 'tag':
      return <Icon.Tag size={15} />
    case 'file':
      return <Icon.Code size={15} />
    case 'commit':
      return <Icon.History size={15} />
    case 'stash':
      return <Icon.Stash size={15} />
    case 'place':
      return item.place === 'worktree' ? <Icon.Worktree size={15} /> : <Icon.Repo size={15} />
  }
}

/** Title, optional subtitle and trailing adornment for a hit. */
function content(hit: PaletteHit): { title: ReactNode; sub?: ReactNode; trail?: ReactNode } {
  const { item, highlights } = hit
  switch (item.kind) {
    case 'command':
      return {
        title: highlightPositions(item.title, highlights[0]),
        trail: item.accelerator && <Shortcut accelerator={item.accelerator} />
      }
    case 'branch':
      return {
        title: highlightPositions(item.ref.name, highlights[0]),
        trail: item.current ? (
          <span className="tag tag--current">current</span>
        ) : item.ref.kind === 'remote' ? (
          <span className="tag">remote</span>
        ) : undefined
      }
    case 'tag':
      return { title: highlightPositions(item.ref.name, highlights[0]) }
    case 'file': {
      // File name first, its folder after it — the name is what you scan for.
      const { dir, name } = splitPath(item.path)
      const offset = item.path.length - name.length
      return {
        title: highlightPositions(name, highlights[0], offset),
        sub: dir && highlightPositions(dir, highlights[0]),
        trail: item.change && (
          <span
            className="palette-row__status"
            data-status={item.change.status}
            data-tip={statusLabel(item.change.status)}
          >
            {statusLetter(item.change.status)}
          </span>
        )
      }
    }
    case 'commit':
      return {
        title: item.commit.subject,
        sub: (
          <>
            <span className="palette-row__sha">
              {highlightPositions(item.commit.shortHash, highlights[0])}
            </span>{' '}
            · {item.commit.authorName} · {item.commit.relativeDate}
          </>
        )
      }
    case 'stash':
      return {
        title: highlightPositions(item.label, highlights[0]),
        sub: item.stash.relativeDate
      }
    case 'place':
      return {
        title: highlightPositions(item.name, highlights[0]),
        sub: highlightPositions(item.path, highlights[1])
      }
  }
}

export function PaletteRow({
  hit,
  entry,
  selected,
  menuOpen,
  hasMenu,
  onHover,
  onActivate,
  onMenu
}: Props) {
  const { title, sub, trail } = content(hit)
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-entry={entry}
      className={`palette-row${selected ? ' is-kbd' : ''}${menuOpen ? ' is-context' : ''}`}
      onMouseMove={onHover}
      onClick={onActivate}
      onContextMenu={
        hasMenu
          ? (e) => {
              e.preventDefault()
              onMenu({ x: e.clientX, y: e.clientY })
            }
          : undefined
      }
    >
      <span className="palette-row__glyph">{glyph(hit)}</span>
      <span className="palette-row__main">
        <span className="palette-row__title">{title}</span>
        {sub && <span className="palette-row__sub">{sub}</span>}
      </span>
      {trail}
      {hasMenu && (
        <button
          type="button"
          className="palette-row__more"
          aria-label="Actions"
          data-tip="Actions (Tab)"
          onClick={(e) => {
            e.stopPropagation()
            onMenu(e.currentTarget.getBoundingClientRect())
          }}
        >
          <Icon.More size={16} />
        </button>
      )}
    </div>
  )
}
