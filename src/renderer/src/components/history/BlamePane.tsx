import type { CodeViewFileItem, CodeViewOptions } from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import type { BlameLine } from '@shared/types'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ageColor,
  ageFraction,
  ageRange,
  ageScale,
  BLAME_LINE_HEIGHT,
  type BlameFrame,
  blameWindow,
  canReblame,
  isRunStart,
  popReblame,
  pushReblame
} from '@/lib/blame'
import { splitPath } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { ResolvedTheme } from '@/lib/theme'
import { useSpinDelay } from '@/lib/useSpinDelay'
import { Avatar } from './Avatar'

interface Props {
  repoPath: string
  /** File path at the initial revision. */
  path: string
  /** Initial revision to blame, or null for the working tree. */
  baseRef: string | null
  theme: ResolvedTheme
}

/** Short local date for the gutter (e.g. "Apr 21, 2026"). */
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
 * aligned row-for-row at any scroll position. Clicking a line's commit reblames
 * the file at that commit's parent; a breadcrumb walks back.
 */
export function BlamePane({ repoPath, path, baseRef, theme }: Props) {
  // Reblame history. The bottom frame is the file as opened; each click pushes
  // the clicked line's parent revision + its path there (rename-correct).
  const [stack, setStack] = useState<BlameFrame[]>(() => [
    { ref: baseRef, path, label: baseRef ? baseRef.slice(0, 7) : 'working tree' }
  ])
  const frame = stack[stack.length - 1]

  const [lines, setLines] = useState<BlameLine[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const spin = useSpinDelay(loading)

  // (Re)load blame whenever the current frame changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.gitgrove
      .blame(repoPath, frame.path, frame.ref ?? undefined)
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
  }, [repoPath, frame.ref, frame.path])

  // ── Synced scroll ────────────────────────────────────────────────────────
  // The editor owns the scroll; the gutter follows. `scrollTop` is the editor's
  // logical offset; `viewportH` (the shared body height) bounds the window.
  const cvRef = useRef<CodeViewHandle<undefined>>(null)
  // Body node via a state-backed callback ref: it mounts only once blame has
  // loaded (the loading/error branches don't render it), so a plain ref + `[]`
  // effect would measure null and leave the gutter window at zero rows.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)

  useLayoutEffect(() => {
    if (!bodyEl) return
    const measure = () => setViewportH(bodyEl.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bodyEl)
    return () => ro.disconnect()
  }, [bodyEl])

  // Wheeling over the gutter must scroll the editor too (separate columns don't
  // share native scroll). Forward the delta to the CodeView; its `onScroll`
  // then moves both. Non-passive so the page never scrolls underneath.
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
      id: `${frame.ref ?? 'wt'}:${frame.path}`,
      type: 'file',
      file: { name: splitPath(frame.path).name, contents }
    }),
    [frame.ref, frame.path, contents]
  )
  const items = useMemo(() => [item], [item])
  // Age span of the file's commits, for the per-line heat stripe + legend.
  const range = useMemo(() => ageRange(lines ?? []), [lines])

  const back = () => setStack(popReblame(stack))

  if (error) {
    return (
      <div className="blame">
        <BlameHead stack={stack} onBack={back} showLegend={false} />
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
        <BlameHead stack={stack} onBack={back} showLegend={false} />
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

  return (
    <div className="blame">
      <BlameHead stack={stack} onBack={back} showLegend />
      <div className="blame-body" ref={setBodyEl}>
        <div className="blame-gutter" aria-hidden="true">
          <div
            className="blame-gutter__content"
            style={{ transform: `translateY(${-scrollTop}px)` }}
          >
            {visible.map((line, i) => {
              const index = win.start + i
              const runStart = isRunStart(lines, index)
              const reblameable = canReblame(line)
              // Per-line age stripe (older → newer), on every line so a block
              // reads as one continuous colored band beside its source.
              const stripe = ageColor(ageFraction(Date.parse(line.date), range.min, range.max))
              const meta = (
                <>
                  <span className="blame-cell__sha">
                    {line.notCommitted ? 'Uncommitted' : line.shortHash}
                  </span>
                  {!line.notCommitted && (
                    <>
                      <Avatar name={line.authorName} email={line.authorEmail} size={14} />
                      <span className="blame-cell__author">{line.authorName}</span>
                      <span className="blame-cell__date">{shortDate(line.date)}</span>
                    </>
                  )}
                </>
              )
              return (
                <div key={index} className="blame-cell" style={{ top: index * BLAME_LINE_HEIGHT }}>
                  <span className="blame-cell__age" style={{ background: stripe }} />
                  {runStart &&
                    (reblameable ? (
                      <button
                        type="button"
                        className="blame-cell__btn"
                        data-tip={`${line.summary}\nBlame parent (${line.previous?.hash.slice(0, 7)})`}
                        onClick={() => setStack((s) => pushReblame(s, line))}
                      >
                        {meta}
                      </button>
                    ) : (
                      <span
                        className="blame-cell__static"
                        data-tip={line.notCommitted ? 'Not committed yet' : line.summary}
                      >
                        {meta}
                      </span>
                    ))}
                </div>
              )
            })}
          </div>
        </div>
        <CodeView<undefined>
          key={`${theme}`}
          ref={cvRef}
          items={items}
          options={codeOptions}
          disableWorkerPool
          onScroll={(st) => setScrollTop(st)}
          className="blame-code"
        />
        {/* Hairlines across both columns at each commit boundary so it's clear
            which source lines belong to which blame band. */}
        <div className="blame-rules" aria-hidden="true">
          <div
            className="blame-rules__content"
            style={{ transform: `translateY(${-scrollTop}px)` }}
          >
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
 * Blame header — styled like the diff viewer's header for a consistent feel.
 * Right side carries the age legend (older → newer); the left gains a Back
 * control and the reblamed revision only once the user has walked back from
 * the base (whose details the common commit summary already shows).
 */
function BlameHead({
  stack,
  onBack,
  showLegend
}: {
  stack: BlameFrame[]
  onBack: () => void
  showLegend: boolean
}) {
  const reblamed = stack.length > 1
  const frame = stack[stack.length - 1]
  return (
    <div className="blame-head">
      {reblamed && (
        <>
          <button type="button" className="blame-head__back" onClick={onBack}>
            <Icon.Undo size={13} /> Back
          </button>
          <span className="blame-head__label">
            Blaming <code>{splitPath(frame.path).name}</code> @ <strong>{frame.label}</strong>
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
