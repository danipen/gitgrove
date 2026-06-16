import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface Tip {
  text: string
  /** Optional dimmed second line (`data-tip-sub`), e.g. an author's email. */
  sub?: string
  /** Pointer position at show time — the tip is anchored to the cursor. */
  pointerX: number
  pointerY: number
}

const SHOW_DELAY = 120

/**
 * True when the element's text is clipped, or any descendant's is — so a
 * `data-tip-overflow` host can wrap children that do the actual truncating
 * (e.g. a path whose directory segment ellipsizes while the filename stays).
 */
function isClipped(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 1) return true
  for (const child of el.querySelectorAll('*')) {
    if (child.scrollWidth > child.clientWidth + 1) return true
  }
  return false
}

/**
 * A single delegated tooltip for the whole app. Any element carrying a `data-tip`
 * attribute shows it on hover — rendered in a portal so the truncation
 * `overflow: hidden` ancestors can't clip it. Add `data-tip-overflow` to only
 * show the tip when the element's text is actually truncated.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const [coords, setCoords] = useState<{
    top: number
    left: number
    placement: 'above' | 'below'
    arrowX: number
  } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointer = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const clear = () => {
      clearTimeout(timer.current)
    }
    const hide = () => {
      clear()
      setTip(null)
      setCoords(null)
    }
    const onMove = (e: MouseEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY }
    }
    const onOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const el = target?.closest?.('[data-tip]') as HTMLElement | null
      if (!el) {
        hide()
        return
      }
      const text = el.getAttribute('data-tip')
      if (!text) return hide()
      // Skip when the label isn't actually clipped.
      if (el.hasAttribute('data-tip-overflow') && !isClipped(el)) {
        return hide()
      }
      clear()
      const sub = el.getAttribute('data-tip-sub') ?? undefined
      timer.current = setTimeout(
        () => setTip({ text, sub, pointerX: pointer.current.x, pointerY: pointer.current.y }),
        SHOW_DELAY
      )
    }
    const onOut = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[data-tip]')) hide()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      clear()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // A cursor-anchored tooltip with a caret that points at the pointer. It drops
  // just below the cursor (caret on top pointing up) and flips above only near
  // the bottom edge. The bubble starts a little left of the cursor so the caret
  // sits near its leading edge, then shifts to stay on screen while the caret
  // keeps tracking the cursor X.
  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return
    const t = tipRef.current.getBoundingClientRect()
    const m = 8 // viewport margin
    const gap = 18 // cursor → bubble edge: clears the cursor glyph so the caret shows
    const arrowInset = 18 // where the caret prefers to sit from the near edge
    const { pointerX, pointerY } = tip
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Below the cursor by default; flip above if it wouldn't fit below.
    let placement: 'above' | 'below' = 'below'
    let top = pointerY + gap
    if (top + t.height > vh - m) {
      placement = 'above'
      top = pointerY - gap - t.height
    }
    top = Math.max(m, Math.min(top, vh - t.height - m))

    // Anchor the leading edge near the cursor, then shift to stay on screen.
    const left = Math.max(m, Math.min(pointerX - arrowInset, vw - t.width - m))

    // The caret keeps pointing at the cursor, clamped inside the rounded ends.
    const arrowX = Math.max(14, Math.min(pointerX - left, t.width - 14))

    setCoords({ top, left, placement, arrowX })
  }, [tip])

  if (!tip) return null

  return createPortal(
    <div
      ref={tipRef}
      className={`tooltip${coords ? ` tooltip--${coords.placement}` : ''}`}
      role="tooltip"
      style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999 }}
    >
      {tip.text}
      {tip.sub && <div className="tooltip__sub">{tip.sub}</div>}
      {coords && <span className="tooltip__arrow" style={{ left: coords.arrowX - 5 }} />}
    </div>,
    document.body
  )
}
