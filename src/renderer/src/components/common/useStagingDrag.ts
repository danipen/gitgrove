import { useCallback, useRef } from 'react'
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
  /** Key of the line last under the pointer, to skip the flood of same-line moves. */
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
 * Returns the line-enter handler for pierre's diff options plus `bodyRef`, a
 * callback ref for the diff body: the gutter pointerdown is a native capture
 * listener (it must see the event before pierre's shadow DOM), and a callback ref
 * re-binds it whenever that element mounts or is swapped — which a one-shot effect
 * would miss when the body unmounts (e.g. switching to a multi-file selection).
 */
export function useStagingDrag(ctx: StagingDragContext) {
  // The handlers are stable so pierre's options don't churn; they read the live
  // context through this ref rather than closing over each render's values.
  const ref = useRef(ctx)
  ref.current = ctx
  const stroke = useRef<Stroke | null>(null)
  // The diff body the listener is bound to (also where the no-text-select
  // attribute rides during a stroke).
  const body = useRef<HTMLDivElement | null>(null)

  // Repaint the run from anchor to the line currently under the pointer. The base
  // is the press-time snapshot, so a fast drag whose moves batch in one frame
  // stays correct, and dragging back simply yields a shorter range.
  const paintTo = useCallback((current: ChangedLine) => {
    const s = stroke.current
    if (!s) return
    const c = ref.current
    const range = rangeChangedLines(c.blocks, c.unified, s.anchor, current)
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
    body.current?.removeAttribute('data-staging-drag')
    window.removeEventListener('pointerup', endStroke)
    window.removeEventListener('pointercancel', endStroke)
  }, [])

  // Captured before the event reaches pierre's shadow DOM; composedPath() still
  // exposes the gutter cell across the boundary.
  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      if (!ref.current.enabled || e.button !== 0) return
      const anchor = gutterChangeCell(e.composedPath())
      if (!anchor) return
      e.preventDefault() // don't begin a text selection from the gutter
      const c = ref.current
      const block = c.owner.get(lineKey(anchor))
      if (block === undefined) return
      // Paint the run to the opposite of the anchor's current state, the way a
      // single click would have flipped it.
      const exclude = !excludedKeysFor(c.selection, c.blocks, block).has(lineKey(anchor))
      stroke.current = { base: c.selection, anchor, exclude, lastKey: lineKey(anchor) }
      body.current?.setAttribute('data-staging-drag', '')
      paintTo(anchor) // flip the pressed line right away
      window.addEventListener('pointerup', endStroke)
      window.addEventListener('pointercancel', endStroke)
    },
    [paintTo, endStroke]
  )

  // Bind the capture listener to the diff body, re-binding if the element changes.
  const bodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      body.current?.removeEventListener('pointerdown', onPointerDown, true)
      body.current = el
      el?.addEventListener('pointerdown', onPointerDown, true)
    },
    [onPointerDown]
  )

  const onLineEnter = useCallback(
    (props: LineEvent) => {
      const s = stroke.current
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

  return { bodyRef, onLineEnter, onLineNumberClick }
}
