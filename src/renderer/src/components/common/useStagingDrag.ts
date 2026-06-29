import { type RefObject, useCallback, useEffect, useRef } from 'react'
import type { FileSelection } from '@/lib/commit-selection'
import {
  type ChangeBlock,
  type ChangedLine,
  type DisplayMeta,
  excludedKeysFor,
  lineKey,
  paintSelection,
  rangeChangedLines
} from '@/lib/staging'

type LineType = ChangedLine['type']

/** The subset of a pierre diff-line event (enter) that we read. */
interface LineEvent {
  lineType: string
  lineNumber: number
  event: PointerEvent
}

/** The live state the gutter interaction needs, refreshed every render. */
export interface StagingDragContext {
  /** Gutter staging is live: a working diff is shown and not mid-commit. */
  enabled: boolean
  /** True when the diff is unified (one interleaved column), false for split. */
  unified: boolean
  path: string
  meta: DisplayMeta
  blocks: ChangeBlock[]
  owner: ReadonlyMap<string, number>
  selection: FileSelection
  onChange: (selection: FileSelection) => void
}

/** An in-progress drag over the gutter. */
interface Stroke {
  /** Selection snapshot at press — the base every move repaints from. */
  base: FileSelection
  /** The line whose gutter number started the stroke; one end of the range. */
  anchor: ChangedLine
  /** What the run is painted to: true leaves it out of the commit, false puts in. */
  exclude: boolean
  /** Key of the line the pointer was last over, to skip the flood of same-line moves. */
  lastKey: string
}

const isChange = (type: string): type is LineType =>
  type === 'change-addition' || type === 'change-deletion'

/** The changed line whose gutter number a pointerdown landed on, if any. */
function gutterChangeCell(path: readonly (EventTarget | undefined)[]): ChangedLine | null {
  for (const node of path) {
    if (!(node instanceof Element)) continue
    // The number cell carries the line number as its `data-column-number` value
    // (and the type as `data-line-type`); the content cell has neither, so this
    // fires only for a press *in the gutter* — diff text stays selectable.
    if (!node.hasAttribute('data-column-number')) continue
    const type = node.getAttribute('data-line-type')
    if (!type || !isChange(type)) return null
    const lineNumber = Number(node.getAttribute('data-column-number'))
    return Number.isFinite(lineNumber) ? { type, lineNumber } : null
  }
  return null
}

/**
 * Click + drag-to-select for the per-line "include in commit" gutter. Pressing a
 * changed line's number flips it (on pointerdown, so the feedback is instant);
 * holding and dragging then paints the whole run from that anchor to the line
 * under the pointer to the *same* state the anchor took — so one stroke includes
 * (or excludes) a range instead of a click per line. The run is recomputed from
 * the anchor on every move (never accumulated), so dragging back past the
 * pointer shrinks it and overshooting a line corrects itself; painting a fixed
 * value (not a flip) means sweeping over already-set lines never checkerboards.
 * The stroke *starts* in the gutter (so diff text stays selectable) but, once
 * dragging, follows the line under the pointer anywhere across the diff and flows
 * across change blocks. It's all pure renderer state — git is touched only at
 * commit time (see lib/staging).
 *
 * Returns the line-enter handler for pierre's diff options; the gutter
 * pointerdown is wired directly onto `bodyRef` (a native capture listener
 * catches it before it reaches pierre's shadow DOM).
 */
export function useStagingDrag(ctx: StagingDragContext, bodyRef: RefObject<HTMLDivElement | null>) {
  // The handlers are stable so pierre's options don't churn; they read the live
  // context through this ref rather than closing over each render's values.
  const ref = useRef(ctx)
  ref.current = ctx
  const stroke = useRef<Stroke | null>(null)

  // Repaint the run from anchor to the line currently under the pointer. The base
  // is the press-time snapshot, so a fast drag whose moves batch in one frame
  // stays correct, and dragging back simply yields a shorter range.
  const paintTo = useCallback((current: ChangedLine) => {
    const s = stroke.current
    if (!s) return
    const c = ref.current
    const range = rangeChangedLines(c.blocks, c.unified, s.anchor, current)
    // biome-ignore lint/suspicious/noExplicitAny: temp probe
    ;(window as any).__sd = { paintTo: current, rangeLen: range.length, exclude: s.exclude, blocks: c.blocks.length, unified: c.unified }
    if (range.length === 0) return // pointer left the anchor's track — keep the last run
    c.onChange(
      paintSelection(
        c.path,
        c.meta,
        c.blocks,
        c.owner,
        (i) => excludedKeysFor(s.base, c.blocks, i),
        range,
        s.exclude
      )
    )
  }, [])

  const endStroke = useCallback(() => {
    stroke.current = null
    bodyRef.current?.removeAttribute('data-staging-drag')
    window.removeEventListener('pointerup', endStroke)
    window.removeEventListener('pointercancel', endStroke)
  }, [bodyRef])

  // A native capture listener catches the pointerdown before it reaches pierre's
  // shadow DOM; composedPath() still exposes the gutter cell across the boundary.
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const onPointerDown = (e: PointerEvent) => {
      // biome-ignore lint/suspicious/noExplicitAny: temp probe
      ;(window as any).__pd = { enabled: ref.current.enabled, button: e.button }
      if (!ref.current.enabled || e.button !== 0) return
      const anchor = gutterChangeCell(e.composedPath())
      // biome-ignore lint/suspicious/noExplicitAny: temp probe
      ;(window as any).__pd.anchor = anchor
      if (!anchor) return
      e.preventDefault() // don't begin a text selection from the gutter
      const c = ref.current
      const block = c.owner.get(lineKey(anchor))
      if (block === undefined) return
      // Paint the run to the opposite of the anchor's current state, the way a
      // single click would have flipped it.
      const exclude = !excludedKeysFor(c.selection, c.blocks, block).has(lineKey(anchor))
      stroke.current = { base: c.selection, anchor, exclude, lastKey: lineKey(anchor) }
      body.setAttribute('data-staging-drag', '')
      paintTo(anchor) // flip the pressed line right away
      window.addEventListener('pointerup', endStroke)
      window.addEventListener('pointercancel', endStroke)
    }
    body.addEventListener('pointerdown', onPointerDown, true)
    return () => body.removeEventListener('pointerdown', onPointerDown, true)
  }, [bodyRef, endStroke, paintTo])

  const onLineEnter = useCallback(
    (props: LineEvent) => {
      const s = stroke.current
      // biome-ignore lint/suspicious/noExplicitAny: temp probe
      ;(window as any).__le = { fired: ((window as any).__le?.fired ?? 0) + 1, stroke: !!s, buttons: props.event.buttons, line: props.lineNumber, type: props.lineType }
      if (!s) return
      if (!(props.event.buttons & 1)) {
        endStroke() // primary button is no longer down — the stroke is over
        return
      }
      if (!isChange(props.lineType)) return
      const line: ChangedLine = { type: props.lineType, lineNumber: props.lineNumber }
      // pierre fires onLineEnter on every move; only repaint when the pointer has
      // actually crossed into a different line.
      if (lineKey(line) === s.lastKey) return
      s.lastKey = lineKey(line)
      paintTo(line)
    },
    [paintTo, endStroke]
  )

  // pierre keeps the line numbers interactive (cursor + hover affordance) only
  // when a click handler is wired; toggling itself happens on pointerdown above.
  const onLineNumberClick = useCallback(() => {}, [])

  return { onLineEnter, onLineNumberClick }
}
