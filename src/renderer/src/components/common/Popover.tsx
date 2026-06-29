import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface PopoverProps {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  /** Preferred horizontal alignment relative to the anchor. */
  align?: 'left' | 'right'
  width?: number
  children: ReactNode
}

/**
 * A lightweight floating panel anchored to a trigger element. Closes on outside
 * click and Escape. Opens below the anchor by default and flips above it when
 * there isn't enough room (e.g. the commit button at the window's bottom edge).
 * Positioned after a hidden measurement pass so the flip never flashes.
 */
export function Popover({ anchor, open, onClose, align = 'left', width, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  // Whether this open has already focused its [data-autofocus] control.
  const focused = useRef(false)

  // Reset on close so the next open re-measures fresh content.
  useEffect(() => {
    if (!open) {
      setPos(null)
      focused.current = false
    }
  }, [open])

  // Focus the marked control (e.g. a filter input) once the panel is actually
  // visible. React's autoFocus can't do this: it fires on mount, during the
  // hidden measurement pass, where the browser refuses focus(). Runs once per
  // open — re-measures (children changing while the user types) must not yank
  // focus back. We only latch `focused` once we've *actually* focused an
  // element: when the control is rendered from async data (e.g. the repo
  // switcher's filter appears only after the recents load), it's absent on the
  // first measure, so the next re-measure must get another chance to focus it.
  useEffect(() => {
    if (!pos || focused.current) return
    const target = ref.current?.querySelector<HTMLElement>('[data-autofocus]')
    if (!target) return
    focused.current = true
    target.focus()
  }, [pos])

  // biome-ignore lint/correctness/useExhaustiveDependencies: children affect the measured height
  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return
    const r = anchor.getBoundingClientRect()
    const { height } = ref.current.getBoundingClientRect()
    const w = width ?? Math.max(r.width, 240)
    const margin = 8
    let left = align === 'right' ? r.right - w : r.left
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin))
    // Below the anchor when it fits, above it otherwise — clamped to the viewport.
    let top = r.bottom + 6
    if (top + height > window.innerHeight - margin) top = r.top - 6 - height
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin))
    setPos({ top, left, minWidth: w })
  }, [open, anchor, align, width, children])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <>
      <div className="popover-backdrop" onMouseDown={onClose} />
      <div
        ref={ref}
        className="popover"
        // Render off-screen-stable until measured so it never flashes at the
        // unflipped position before the fit check lands.
        style={
          pos
            ? { top: pos.top, left: pos.left, minWidth: pos.minWidth }
            : { top: 0, left: 0, minWidth: width ?? 240, visibility: 'hidden' }
        }
        role="dialog"
      >
        {children}
      </div>
    </>,
    document.body
  )
}
