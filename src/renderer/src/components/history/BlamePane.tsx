import type { CodeViewFileItem, CodeViewOptions } from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import type { BlameLine } from '@shared/types'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ageColor,
  ageFraction,
  ageRange,
  ageScale,
  BLAME_LINE_HEIGHT,
  blameRuns,
  blameWindow,
  canReblame,
  isRunStart,
  stickyRun
} from '@/lib/blame'
import { splitPath } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { ResolvedTheme } from '@/lib/theme'
import { useSpinDelay } from '@/lib/useSpinDelay'
import { Avatar } from './Avatar'

interface Props {
  repoPath: string
  /** File path at the current (possibly reblamed) revision — rename-correct. */
  path: string
  /** Current revision to blame, or null for the working tree. */
  blameRef: string | null
  theme: ResolvedTheme
  /** True once the user has walked back from the anchored revision. */
  reblamed: boolean
  /** Compact label of the current revision (short sha / "working tree"). */
  frameLabel: string
  /** Walk back to the parent of the clicked line's commit. */
  onReblame: (line: BlameLine) => void
  /** Pop one reblame step. */
  onBack: () => void
  /** Report the file-history commit this blame is effectively at, so the commit
   *  list can highlight it. The revision actually blamed (a reblame's parent)
   *  is often *not* a file-touching commit and so isn't in the list; the blame's
   *  newest line, by contrast, always is — it's the most recent change at or
   *  before that revision. `null` for the working tree. */
  onBlamedAt: (hash: string | null) => void
  /** Open a line's commit in the main History tab (the commit-message link). */
  onOpenCommit: (hash: string) => void
}

/** Snap a CSS-pixel value onto the device-pixel grid (dpr read fresh). */
function roundToDevicePixel(value: number): number {
  const dpr = window.devicePixelRatio || 1
  return Math.round(value * dpr) / dpr
}

/** Short local date for tooltips (e.g. "Apr 21, 2026"). */
function shortDate(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * Blame view: a per-line authorship gutter beside the file source. The source
 * is rendered by Pierre's virtualized `CodeView`; the gutter is a separate
 * column we virtualize ourselves and drive off the editor's `onScroll`, with a
 * line height pinned (`--diffs-line-height`, see global.css) so the two stay
 * aligned row-for-row at any scroll position. The reblame stack lives in the
 * overlay (it also drives the commit list's selection); clicking a line's
 * "blame prior" button reblames the file at that commit's parent.
 */
export function BlamePane({
  repoPath,
  path,
  blameRef,
  theme,
  reblamed,
  frameLabel,
  onReblame,
  onBack,
  onBlamedAt,
  onOpenCommit
}: Props) {
  const [lines, setLines] = useState<BlameLine[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const spin = useSpinDelay(loading)

  // (Re)load blame whenever the revision/path being blamed changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.gitgrove
      .blame(repoPath, path, blameRef ?? undefined)
      .then((result) => {
        if (cancelled) return
        setLines(result)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message || 'Failed to blame this file.')
        setLines(null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repoPath, blameRef, path])

  // Tell the overlay which file-history commit this blame is effectively at, so
  // the commit list highlights it. The working tree maps to `null`; otherwise
  // it's the blame's most recent committed line (always a file-touching commit,
  // hence in the list — unlike the raw reblamed parent ref).
  useEffect(() => {
    if (!lines) return
    if (blameRef === null) {
      onBlamedAt(null)
      return
    }
    let newest: BlameLine | null = null
    for (const l of lines) {
      if (l.notCommitted) continue
      if (newest === null || Date.parse(l.date) > Date.parse(newest.date)) newest = l
    }
    onBlamedAt(newest?.hash ?? blameRef)
  }, [lines, blameRef, onBlamedAt])

  // ── Synced scroll ────────────────────────────────────────────────────────
  // Pierre scrolls its code on a *native* (compositor-driven) scroll. Following
  // it from the main thread — an `onScroll` listener or an rAF that reads the
  // scroll position — always trails the compositor by a frame, which reads as
  // the gutter lagging the code mid-scroll. So instead the gutter and the
  // section rules track the code with a CSS scroll-driven animation bound to
  // that same native scroll (see `.blame-code` / `blame-follow` in global.css):
  // it runs on the compositor in true lockstep, no JS in the scroll path. React
  // only feeds it `--blame-range` (the keyframe's end translate) and `scrollTop`
  // (windowing); neither is needed per frame.
  const cvRef = useRef<CodeViewHandle<undefined>>(null)
  // Body node via a state-backed callback ref: it mounts only once blame has
  // loaded (the loading/error branches don't render it), so a plain ref + `[]`
  // effect would measure null and leave the gutter window at zero rows.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)

  // Pin `--blame-range` to the editor's scrollable distance so the follow
  // animation maps the scroll-timeline's 0→1 progress onto exactly 0→-maxScroll
  // — i.e. the gutter/rules translate equals the *same* native scrollTop the code
  // rides, lockstep and pixel-identical at every position. The distance must be
  // the timeline's *exact* value (`scrollHeight - clientHeight` in fractional
  // layout px); using the integer `clientHeight` leaves a sub-pixel error that
  // accumulates across the scroll and shears the gutter off the code (the lines
  // blur where the drift nears ½px). `--blame-range` is fed from the fractional
  // viewport height below; `viewportH` (rounded) only drives the row window.
  const [viewportH, setViewportH] = useState(0)
  const viewportHRef = useRef(0)
  const applyRange = useCallback(() => {
    const code = bodyEl?.querySelector<HTMLElement>('.blame-code')
    if (!code || !bodyEl) return
    bodyEl.style.setProperty(
      '--blame-range',
      `${Math.max(0, code.scrollHeight - viewportHRef.current)}px`
    )
  }, [bodyEl])

  useLayoutEffect(() => {
    const code = bodyEl?.querySelector<HTMLElement>('.blame-code')
    if (!code) return
    // A new file/revision remounts the body and reloads the editor at the top;
    // reset the window so it doesn't briefly render the old scroll's rows.
    setScrollTop(0)
    // Observe the code viewport's *content box* — `contentBoxSize` is fractional
    // and excludes any scrollbar, so it matches the timeline's client height to
    // sub-pixel precision (a horizontal scrollbar on long lines would otherwise
    // skew it). Resync synchronously on every resize step (no rAF, no state
    // round-trip): the native scroll distance changes the instant the viewport
    // does, so a deferred update shears the gutter against the code mid-drag.
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentBoxSize?.[0]
      viewportHRef.current = box ? box.blockSize : code.clientHeight
      setViewportH(Math.round(viewportHRef.current))
      applyRange()
    })
    ro.observe(code, { box: 'content-box' })
    return () => ro.disconnect()
  }, [bodyEl, applyRange])

  // After content (`lines`) changes Pierre re-renders, and its scrollHeight is
  // only correct on the next frame — defer one rAF before reading it (the
  // viewport is unchanged, so the ResizeObserver wouldn't fire on its own).
  useLayoutEffect(() => {
    if (!bodyEl || !lines) return
    const raf = requestAnimationFrame(applyRange)
    return () => cancelAnimationFrame(raf)
  }, [bodyEl, lines, applyRange])

  // ── Crisp hairlines at rest ────────────────────────────────────────────────
  // While scrolling, the follow rides Pierre's exact (sub-pixel) scroll position
  // — perfectly synced, but the 1px section rules are as soft as Pierre's own
  // sub-pixel-positioned code. Pierre never snaps the native scroll to whole
  // pixels (CodeView only `applyScrollFix`es on programmatic/page scrolls), so
  // crispness and exact-sync can't both hold mid-scroll. The moment scrolling
  // stops, though, we freeze the gutter/rules on a device-pixel-rounded offset
  // (`--blame-rest-y`, via `.is-resting`) so the lines snap onto whole physical
  // pixels — a ≤½px nudge off the resting code, imperceptible but crisp. The
  // class is toggled imperatively so the per-event scroll path stays render-free,
  // and the debounce is long enough that slow scrolling stays in smooth-follow
  // mode rather than flickering crisp/soft between micro-movements.
  const restTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const settleAtRest = useCallback(
    (st: number) => {
      if (!bodyEl) return
      bodyEl.classList.remove('is-resting')
      clearTimeout(restTimer.current)
      restTimer.current = setTimeout(() => {
        bodyEl.style.setProperty('--blame-rest-y', `${-roundToDevicePixel(st)}px`)
        bodyEl.classList.add('is-resting')
      }, 180)
    },
    [bodyEl]
  )
  useEffect(() => () => clearTimeout(restTimer.current), [])

  // Wheeling over the gutter must scroll the editor too (separate columns don't
  // share native scroll). Forward the delta to the CodeView; its native scroll
  // then drives the timeline that moves both. Non-passive so the page never
  // scrolls underneath.
  useEffect(() => {
    const el = bodyEl?.querySelector<HTMLElement>('.blame-gutter')
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const cv = cvRef.current?.getInstance()
      if (!cv) return
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * BLAME_LINE_HEIGHT : e.deltaY
      cv.scrollTo({ type: 'position', position: cv.getScrollTop() + dy })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [bodyEl])

  const codeOptions = useMemo<CodeViewOptions<undefined>>(
    () => ({
      theme: theme === 'light' ? 'pierre-light' : 'pierre-dark',
      themeType: theme,
      overflow: 'scroll',
      disableFileHeader: true,
      // Pin the geometry so line tops are exactly `index * lineHeight` and the
      // gutter aligns — see BLAME_LINE_HEIGHT / `--diffs-line-height`.
      itemMetrics: { lineHeight: BLAME_LINE_HEIGHT, paddingTop: 0, paddingBottom: 0 },
      // Drop Pierre's default top inset (DEFAULT_CODE_VIEW_LAYOUT adds
      // paddingTop + an above-first-item gap) so the source starts flush at the
      // top — no empty band above line 1. Keep a little bottom breathing room.
      layout: { paddingTop: 0, paddingBottom: 8, gap: 0 }
    }),
    [theme]
  )

  const contents = useMemo(() => (lines ? lines.map((l) => l.content).join('\n') : ''), [lines])
  const item = useMemo<CodeViewFileItem<undefined>>(
    () => ({
      id: `${blameRef ?? 'wt'}:${path}`,
      type: 'file',
      file: { name: splitPath(path).name, contents }
    }),
    [blameRef, path, contents]
  )
  const items = useMemo(() => [item], [item])
  // Age span of the file's commits, for the per-line heat stripe + legend.
  const range = useMemo(() => ageRange(lines ?? []), [lines])
  // Blame runs (one per labelled band), precomputed for the sticky-header lookup.
  const runs = useMemo(() => blameRuns(lines ?? []), [lines])

  if (error) {
    return (
      <div className="blame">
        <BlameHead
          reblamed={reblamed}
          frameLabel={frameLabel}
          path={path}
          onBack={onBack}
          showLegend={false}
        />
        <div className="center-state">
          <div className="icon-ring">
            <Icon.History size={22} />
          </div>
          <h3>Can’t blame this file</h3>
          <p>{error}</p>
        </div>
      </div>
    )
  }

  if (spin || !lines) {
    return (
      <div className="blame">
        <BlameHead
          reblamed={reblamed}
          frameLabel={frameLabel}
          path={path}
          onBack={onBack}
          showLegend={false}
        />
        {spin && (
          <div className="center-state">
            <div className="spinner" />
          </div>
        )}
      </div>
    )
  }

  const win = blameWindow(scrollTop, viewportH, lines.length)
  const visible: BlameLine[] = lines.slice(win.start, win.end)
  // Header of the block crossing the top edge: floated so a tall block keeps its
  // label in view instead of a blank band. Positioned in gutter-viewport coords
  // off React's scrollTop (it can't ride the compositor follow — it must hold at
  // the top, not translate with the block), so it may trail a frame on a fling
  // and lands exact at rest; the age stripes and code stay compositor-locked.
  const sticky = stickyRun(runs, scrollTop)

  return (
    <div className="blame">
      <BlameHead
        reblamed={reblamed}
        frameLabel={frameLabel}
        path={path}
        onBack={onBack}
        showLegend
      />
      <div className="blame-body" ref={setBodyEl}>
        <div className="blame-gutter" aria-hidden="true">
          <div className="blame-gutter__content">
            {visible.map((line, i) => {
              const index = win.start + i
              const runStart = isRunStart(lines, index)
              // Per-line age stripe (older → newer), on every line so a block
              // reads as one continuous colored band beside its source.
              const stripe = ageColor(ageFraction(Date.parse(line.date), range.min, range.max))
              return (
                <div key={index} className="blame-cell" style={{ top: index * BLAME_LINE_HEIGHT }}>
                  <span className="blame-cell__age" style={{ background: stripe }} />
                  {runStart && (
                    <BlameCell line={line} onReblame={onReblame} onOpenCommit={onOpenCommit} />
                  )}
                </div>
              )
            })}
          </div>
          {sticky && (
            <div
              // `--pinned` (top === 0) is the resting, floating-over-content state
              // that earns the shadow; once the next block pushes it up (top < 0)
              // it's just leaving, so the shadow drops and it slides out flat.
              className={`blame-cell blame-cell--sticky${sticky.top === 0 ? ' blame-cell--pinned' : ''}`}
              style={{ top: Math.round(sticky.top) }}
            >
              <span
                className="blame-cell__age"
                style={{
                  background: ageColor(
                    ageFraction(Date.parse(sticky.run.line.date), range.min, range.max)
                  )
                }}
              />
              <BlameCell line={sticky.run.line} onReblame={onReblame} onOpenCommit={onOpenCommit} />
            </div>
          )}
        </div>
        <CodeView<undefined>
          key={`${theme}`}
          ref={cvRef}
          items={items}
          options={codeOptions}
          disableWorkerPool
          onScroll={(st) => {
            setScrollTop(st)
            settleAtRest(st)
          }}
          className="blame-code"
        />
        {/* Hairlines across both columns at each commit boundary so it's clear
            which source lines belong to which blame band. */}
        <div className="blame-rules" aria-hidden="true">
          <div className="blame-rules__content">
            {visible.map((_, i) => {
              const index = win.start + i
              if (index === 0 || !isRunStart(lines, index)) return null
              return (
                <div
                  key={index}
                  className="blame-rule"
                  style={{ top: index * BLAME_LINE_HEIGHT }}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * One run-start gutter cell: who last touched the block and when, plus a
 * "blame prior" button to walk back. The short sha is intentionally dropped —
 * it's noise; the avatar (name + email on hover), the commit summary, and a
 * relative date carry the meaning, mirroring the commit list beside it. The
 * button slot is always present — an empty placeholder when there's nothing
 * earlier to blame — so the relative date stays column-aligned down the gutter.
 */
function BlameCell({
  line,
  onReblame,
  onOpenCommit
}: {
  line: BlameLine
  onReblame: (line: BlameLine) => void
  onOpenCommit: (hash: string) => void
}) {
  if (line.notCommitted) {
    return <span className="blame-cell__msg blame-cell__msg--wt">Uncommitted changes</span>
  }
  return (
    <>
      <Avatar
        name={line.authorName}
        email={line.authorEmail}
        size={16}
        tooltip={`${line.authorName} <${line.authorEmail}>`}
      />
      {/* The commit that last touched this line: short sha + full message,
          always shown (not only when the message is clipped) so the sha — the
          one identifier dropped from the row itself — is always a hover away.
          Clicking it opens that commit in the main History tab. */}
      <button
        type="button"
        className="blame-cell__msg blame-cell__msg--link"
        data-tip={`${line.shortHash} · ${line.summary}`}
        onClick={() => onOpenCommit(line.hash)}
      >
        {line.summary}
      </button>
      <span className="blame-cell__when" data-tip={new Date(line.date).toLocaleString()}>
        {shortDate(line.date)}
      </span>
      {canReblame(line) ? (
        <button
          type="button"
          className="blame-cell__reblame"
          data-tip={`Blame prior to this change, made on ${shortDate(line.date)} (${line.previous?.hash.slice(0, 7)})`}
          onClick={() => onReblame(line)}
        >
          <Icon.BlamePrior size={14} />
        </button>
      ) : (
        <span className="blame-cell__reblame blame-cell__reblame--empty" aria-hidden="true" />
      )}
    </>
  )
}

/**
 * Blame header — styled like the diff viewer's header for a consistent feel.
 * Right side carries the age legend (older → newer); the left gains a Back
 * control and the reblamed revision only once the user has walked back from
 * the anchor (whose details the common commit summary already shows).
 */
function BlameHead({
  reblamed,
  frameLabel,
  path,
  onBack,
  showLegend
}: {
  reblamed: boolean
  frameLabel: string
  path: string
  onBack: () => void
  showLegend: boolean
}) {
  return (
    <div className="blame-head">
      {reblamed && (
        <>
          <button type="button" className="blame-head__back" onClick={onBack}>
            <Icon.Undo size={13} /> Back
          </button>
          <span className="blame-head__label">
            Blaming <code>{splitPath(path).name}</code> @ <strong>{frameLabel}</strong>
          </span>
        </>
      )}
      <span className="blame-head__spacer" />
      {showLegend && (
        <div className="blame-legend" data-tip="Line age — older to newer">
          <span className="blame-legend__cap">Older</span>
          <span className="blame-legend__scale">
            {ageScale().map((c) => (
              <span key={c} style={{ background: c }} />
            ))}
          </span>
          <span className="blame-legend__cap">Newer</span>
        </div>
      )}
    </div>
  )
}
