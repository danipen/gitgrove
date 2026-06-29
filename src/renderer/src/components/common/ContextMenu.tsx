import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  /** Item label. Omit to render a separator instead of a clickable row. */
  label?: string
  icon?: ReactNode
  onClick?: () => void
  /** Render in the destructive (red) style — e.g. a "Remove" action. */
  danger?: boolean
  disabled?: boolean
  /** When present, the row opens a nested menu of these on hover instead of
   *  acting on click — used to tuck a long list (e.g. a branch's PRs) away. */
  submenu?: ContextMenuItem[]
}

interface Props {
  /** Viewport coordinates (typically the cursor) to anchor the menu's corner to. */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * A floating, cursor-anchored menu styled like the app's popovers. Renders into
 * a portal, measures itself once mounted to flip away from the right/bottom
 * edges, and closes on outside click, a second right-click, or Escape. Items
 * carrying a `submenu` open a nested panel on hover (one level deep).
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    // Capture-phase + stopPropagation so Escape dismisses *this* menu only —
    // when the menu is layered over another overlay (e.g. the branch switcher
    // popover, whose own window-level Escape would otherwise also fire) one
    // Escape peels just the top layer, leaving the surface beneath open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <>
      <div
        className="ctx-menu__backdrop"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <MenuPanel items={items} onClose={onClose} at={{ left: x, top: y, right: x, bottom: y }} />
    </>,
    document.body
  )
}

/** Just enough to anchor a panel: the cursor point for the root menu, or a parent
 *  item's bounds for a submenu (which opens to the item's right). */
type AnchorRect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>

/**
 * One menu surface — the root menu or a submenu. Positions itself away from the
 * viewport edges (a submenu opens to the right of its parent item, flipping left
 * when there's no room) and opens a child submenu on hover, kept alive while the
 * pointer is over either the parent item or the submenu.
 */
function MenuPanel({
  items,
  onClose,
  at,
  isSub = false,
  onHoverEnter,
  onHoverLeave
}: {
  items: ContextMenuItem[]
  onClose: () => void
  at: AnchorRect
  isSub?: boolean
  onHoverEnter?: () => void
  onHoverLeave?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const itemEls = useRef<Record<number, HTMLButtonElement | null>>({})
  const closeT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const m = 8
    // A submenu opens to the right of its parent item (overlapping the border a
    // touch), flipping to the left when it would run off-screen; the root opens
    // at the cursor. Either way, clamp inside the viewport.
    let left = isSub ? at.right - 4 : at.left
    if (isSub && left + width > window.innerWidth - m) left = at.left - width + 4
    let top = isSub ? at.top - 5 : at.top
    left = Math.max(m, Math.min(left, window.innerWidth - width - m))
    top = Math.max(m, Math.min(top, window.innerHeight - height - m))
    setPos({ top, left })
  }, [at, isSub])

  const openSub = (i: number) => {
    clearTimeout(closeT.current)
    setOpenIdx(i)
  }
  const scheduleClose = () => {
    closeT.current = setTimeout(() => setOpenIdx(null), 150)
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={
        pos
          ? { top: pos.top, left: pos.left }
          : { top: at.top, left: at.left, visibility: 'hidden' }
      }
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      {items.map((item, i) => {
        if (item.label === undefined) {
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
          return <div key={`sep-${i}`} className="ctx-menu__sep" />
        }
        if (item.submenu) {
          const submenu = item.submenu
          return (
            <div key={item.label} className="ctx-menu__nest">
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openIdx === i}
                ref={(el) => {
                  itemEls.current[i] = el
                }}
                className={`ctx-menu__item ctx-menu__item--parent${openIdx === i ? ' is-open' : ''}`}
                onMouseEnter={() => openSub(i)}
                onMouseLeave={scheduleClose}
              >
                {item.icon && <span className="ctx-menu__icon">{item.icon}</span>}
                <span className="ctx-menu__label">{item.label}</span>
                <span className="ctx-menu__caret" aria-hidden>
                  ›
                </span>
              </button>
              {openIdx === i && itemEls.current[i] && (
                <MenuPanel
                  isSub
                  items={submenu}
                  onClose={onClose}
                  at={itemEls.current[i]!.getBoundingClientRect()}
                  onHoverEnter={() => clearTimeout(closeT.current)}
                  onHoverLeave={scheduleClose}
                />
              )}
            </div>
          )
        }
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`ctx-menu__item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.()
              onClose()
            }}
          >
            {item.icon && <span className="ctx-menu__icon">{item.icon}</span>}
            <span className="ctx-menu__label">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
