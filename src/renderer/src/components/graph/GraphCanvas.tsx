// The Graph tab's canvas: owns pan/zoom, hover, hit-testing and the draw loop.
// All drawing lives in render.ts, geometry/hit-testing in geometry.ts, and the
// layout is computed upstream — this component is the interaction shell.
// styles: styles/features/graph.css

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CommitMeta } from '@/components/history/CommitSummary'
import { stripCoAuthorTrailers } from '@/lib/coauthors'
import { reflowMessage } from '@/lib/reflow'
import { subscribeAvatars } from './avatars'
import {
  captionAlpha,
  captionCenterOffset,
  contentSize,
  HEADER_H,
  hitTest,
  MAX_SCALE,
  MIN_SCALE,
  NODE_R,
  neighborNode,
  nodeX,
  nodeY,
  rowEndpoint,
  toWorldX,
  toWorldY,
  type View
} from './geometry'
import type { BranchSelection, GraphLayout, GraphNode, GraphRow } from './layout'
import { type BackportLink, twinHashes } from './links'
import {
  captionMetrics,
  captionWidthFor,
  computeDayMarks,
  drawScene,
  type GraphPalette,
  labelWidthFor,
  readPalette,
  SUBJECT_FONT
} from './render'
import { hitKey, PING_MS, type SearchHit } from './searchGlow'
import { usePanInertia } from './usePanInertia'
import { useZoomAnimation } from './useZoomAnimation'
import { isDiscreteWheel, wheelZoomFactor } from './zoom'

/** Imperative controls the toolbar's zoom/fit/home buttons drive. */
export interface GraphCanvasHandle {
  zoomIn(): void
  zoomOut(): void
  fit(): void
  jumpToHead(): void
  /** Bring a commit into view (search navigation, keyboard selection). */
  reveal(hash: string): void
  /** Bring a world position into view — branch-label hits have no commit. */
  revealAt(column: number, row: number): void
}

interface Props {
  layout: GraphLayout
  theme: 'dark' | 'light'
  selectedHash: string | null
  /** The branch whose changes view is open — its container lights up. Matched
   *  by (name, tip): empty branches share their tip hash with the anchor's
   *  chain, so a hash alone would light every one of them (layout.ts). */
  selectedBranch: BranchSelection | null
  /** Commits kept at full strength while the rest dim; null = no filter. */
  matches: ReadonlySet<string> | null
  /** The current search hit — a commit, branch label, or tag chip. */
  activeHit: SearchHit | null
  /** Chains whose branch label is itself a hit; null = not searching. */
  hitBranches: ReadonlySet<number> | null
  /** Commits whose tag chip is a hit; null = not searching. */
  hitTags: ReadonlySet<string> | null
  /** Uncommitted change count — drawn as the dashed WIP node on the HEAD row. */
  changesCount: number
  /** Dashed "same change" links between backport twins (see links.ts). */
  links: readonly BackportLink[]
  /** Receives the imperative handle (zoom/fit/jump), for the toolbar. */
  controls: RefObject<GraphCanvasHandle | null>
  onSelectNode: (node: GraphNode | null) => void
  onNodeMenu: (node: GraphNode, x: number, y: number) => void
  /** Click on a branch label — open the branch-changes view. */
  onRowClick: (row: GraphRow) => void
  onRowMenu: (row: GraphRow, x: number, y: number) => void
  /** Double-click on a branch label — checkout. */
  onRowDoubleClick: (row: GraphRow) => void
  /** Click on the WIP node — jump to the Changes tab. */
  onWipClick: () => void
}

/** Extra world pixels the user may pan past the diagram's edge. */
const OVERSCROLL = 80

interface Tooltip {
  /** Screen x of the caption's first glyph (the card's text aligns to it). */
  x: number
  /** Screen y of the caption's anchor (canvas 'middle' baseline). */
  y: number
  node: GraphNode
}

/** .graph-tip box metrics — must mirror graph.css, they offset the card's
 *  first glyph from its `left`/`top`. */
const TIP_BORDER = 1
const TIP_PAD_X = 9
const TIP_PAD_Y = 6
const TIP_SUBJECT_LINE_HEIGHT = 1.45
/** Reading-measure bounds for the card: 420px ≈ 66 chars/line at 12px (the
 *  top of the comfortable range), 300px ≈ 48 (still an easy read). */
const TIP_MAX_WIDTH = 420
const TIP_MIN_WIDTH = 300

/** The card's width cap: TIP_MAX_WIDTH on large windows, but never more than
 *  a quarter of the window — a fixed 420px card occludes a third of the graph
 *  on a laptop. Floored at TIP_MIN_WIDTH so the text column stays readable. */
function tipMaxWidth(): number {
  return Math.min(TIP_MAX_WIDTH, Math.max(TIP_MIN_WIDTH, Math.round(window.innerWidth / 4)))
}

/** Places the card so its subject's first line rasterizes on the caption's
 *  exact glyphs. The caption anchors at a canvas 'middle' baseline; a DOM line
 *  positions text by half-leading + ascent. Both are converted to the shared
 *  alphabetic baseline with real font metrics (captionMetrics), so the hover
 *  swap is pixel-stable — offsets eyeballed from the line height drift by a
 *  pixel and break the "text completes itself in place" illusion.
 *  The card is position: fixed (it must overlay the diff pane below the
 *  stage — see graph.css), so stage-local coordinates translate by the
 *  stage's viewport rect. */
function tipPosition(tip: Tooltip, stage: DOMRect | undefined, fontFamily: string) {
  const m = captionMetrics(fontFamily)
  const lineBox = SUBJECT_FONT * TIP_SUBJECT_LINE_HEIGHT
  const halfLeading = (lineBox - (m.ascent + m.descent)) / 2
  const baselineY = tip.y + m.middleToBaseline
  const stageWidth = stage?.width ?? 0
  const maxWidth = tipMaxWidth()
  return {
    maxWidth,
    // Clamped so the card never runs off the stage's right edge (alignment
    // yields to visibility there, by design).
    left:
      (stage?.left ?? 0) +
      Math.max(
        8,
        Math.min(tip.x - TIP_BORDER - TIP_PAD_X, stageWidth - maxWidth - 2 * TIP_BORDER - 8)
      ),
    top: (stage?.top ?? 0) + baselineY - TIP_BORDER - TIP_PAD_Y - halfLeading - m.ascent
  }
}

export function GraphCanvas({
  layout,
  theme,
  selectedHash,
  selectedBranch,
  matches,
  activeHit,
  hitBranches,
  hitTags,
  changesCount,
  links,
  controls,
  onSelectNode,
  onNodeMenu,
  onRowClick,
  onRowMenu,
  onRowDoubleClick,
  onWipClick
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 })
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 })
  const paletteRef = useRef<GraphPalette | null>(null)
  const rafRef = useRef<number | null>(null)
  const hoverRef = useRef<string | null>(null)
  // Pan gesture: pointer id + start point; becomes a pan after a 3px move so
  // clicks stay clicks. `buttons === 0` checks recover from off-window releases.
  const panRef = useRef<{ id: number; x: number; y: number; panned: boolean } | null>(null)
  const initializedRef = useRef(false)
  /** The current hit's arrival ping progress (0 → 1; 1 = settled, no ping). */
  const matchPulseRef = useRef(1)
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)
  const [cursor, setCursor] = useState<'default' | 'pointer' | 'grabbing'>('default')

  const dayMarks = useMemo(() => computeDayMarks(layout), [layout])
  const headRow = useMemo(() => layout.rows.find((r) => r.isHead) ?? null, [layout])
  const wip = useMemo(
    () =>
      changesCount > 0 && headRow
        ? {
            // On a zero-commit branch the WIP node docks right of the lane's
            // reserved slot; otherwise right of the newest commit column.
            column: headRow.empty ? headRow.endColumn + 1 : layout.columnCount,
            row: headRow.index,
            count: changesCount,
            color: headRow.color
          }
        : null,
    [changesCount, headRow, layout.columnCount]
  )

  // Live values for the draw closure (draw reads refs, never re-subscribes).
  const sceneRef = useRef({
    layout,
    selectedHash,
    selectedBranch,
    matches,
    activeHit,
    hitBranches,
    hitTags,
    wip,
    dayMarks,
    links
  })
  sceneRef.current = {
    layout,
    selectedHash,
    selectedBranch,
    matches,
    activeHit,
    hitBranches,
    hitTags,
    wip,
    dayMarks,
    links
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const { width, height, dpr } = sizeRef.current
    if (width === 0 || height === 0) return
    if (!paletteRef.current) {
      paletteRef.current = readPalette(canvas, theme === 'dark')
    }
    const s = sceneRef.current
    drawScene(ctx, {
      layout: s.layout,
      view: viewRef.current,
      width,
      height,
      dpr,
      palette: paletteRef.current,
      selectedHash: s.selectedHash,
      selectedBranch: s.selectedBranch,
      hoverHash: hoverRef.current,
      matches: s.matches,
      activeHit: s.activeHit,
      hitBranches: s.hitBranches,
      hitTags: s.hitTags,
      matchPulse: matchPulseRef.current,
      wip: s.wip,
      dayMarks: s.dayMarks,
      links: s.links
    })
  }, [theme])

  const invalidate = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      draw()
    })
  }, [draw])

  const clampView = useCallback(() => {
    const view = viewRef.current
    const { width, height } = sizeRef.current
    const cs = contentSize(sceneRef.current.layout, sceneRef.current.wip?.column ?? null)
    const cw = cs.width * view.scale
    const ch = cs.height * view.scale
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
    // Content that fits the viewport pins to the top-left, so the mainline
    // always hugs the date header instead of floating mid-canvas; larger
    // content pans freely with a little overscroll slack.
    view.x = cw <= width - 16 ? 8 : clamp(view.x, width - cw - OVERSCROLL, OVERSCROLL)
    view.y =
      ch <= height - HEADER_H - 16
        ? HEADER_H + 8
        : clamp(view.y, height - ch - OVERSCROLL / 2, HEADER_H + 8)
  }, [])

  /** Sets an absolute scale keeping the anchor screen point over the same
   *  world point — the shared primitive under pinch, wheel glide and the
   *  zoom buttons. */
  const applyScaleAt = useCallback(
    (screenX: number, screenY: number, scale: number) => {
      const view = viewRef.current
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
      if (next === view.scale) return
      view.x = screenX - ((screenX - view.x) / view.scale) * next
      view.y = screenY - ((screenY - view.y) / view.scale) * next
      view.scale = next
      clampView()
      setTooltip(null)
      invalidate()
    },
    [clampView, invalidate]
  )

  // Discrete zoom steps (mouse-wheel notches, toolbar, +/- keys) glide toward
  // their target instead of landing as hard jumps — see zoom.ts for the
  // momentum model. Pinch stays 1:1 and bypasses this entirely.
  const zoomAnim = useZoomAnimation(applyScaleAt, () => viewRef.current.scale)

  /** Immediate (unanimated) zoom by a factor — the pinch path. */
  const zoomAt = useCallback(
    (screenX: number, screenY: number, factor: number) => {
      zoomAnim.stop()
      applyScaleAt(screenX, screenY, viewRef.current.scale * factor)
    },
    [zoomAnim, applyScaleAt]
  )

  /** Pans by a screen delta and reports the clamped, actually-applied move —
   *  the shared primitive under drags, wheel scrolling and the drag fling. */
  const panBy = useCallback(
    (dx: number, dy: number) => {
      const view = viewRef.current
      const x0 = view.x
      const y0 = view.y
      view.x += dx
      view.y += dy
      clampView()
      invalidate()
      return { dx: view.x - x0, dy: view.y - y0 }
    },
    [clampView, invalidate]
  )

  // A mouse drag stops dead on release; trackpad panning coasts because the
  // OS bakes inertia into its wheel stream. This levels the two: the drag's
  // release velocity keeps the view gliding — see pan.ts for the model.
  const panInertia = usePanInertia(panBy)

  const centerOn = useCallback(
    (column: number, row: number, xRatio = 0.5) => {
      zoomAnim.stop()
      panInertia.cancel()
      const view = viewRef.current
      const { width, height } = sizeRef.current
      view.x = width * xRatio - nodeX(column) * view.scale
      view.y = (height + HEADER_H) / 2 - nodeY(row) * view.scale
      clampView()
      invalidate()
    },
    [zoomAnim, panInertia, clampView, invalidate]
  )

  const fit = useCallback(() => {
    zoomAnim.stop()
    panInertia.cancel()
    const { width, height } = sizeRef.current
    const cs = contentSize(sceneRef.current.layout, sceneRef.current.wip?.column ?? null)
    const view = viewRef.current
    view.scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((width - 24) / cs.width, (height - HEADER_H - 16) / cs.height))
    )
    // Top-left anchored: the mainline belongs at the top, under the header.
    view.x = 8
    view.y = HEADER_H + 8
    clampView()
    invalidate()
  }, [zoomAnim, panInertia, clampView, invalidate])

  const jumpToHead = useCallback(() => {
    const s = sceneRef.current
    const head = s.layout.headHash ? s.layout.nodeByHash.get(s.layout.headHash) : null
    if (head) {
      // HEAD sits at 70% width so the newest commits and the WIP node fit right of it.
      centerOn(head.column, head.row, 0.7)
    } else if (s.layout.nodes.length > 0) {
      fit()
    }
  }, [centerOn, fit])

  const revealAt = useCallback(
    (column: number, row: number) => {
      const view = viewRef.current
      const { width, height } = sizeRef.current
      const sx = nodeX(column) * view.scale + view.x
      const sy = nodeY(row) * view.scale + view.y
      const pad = 60
      if (sx < pad || sx > width - pad || sy < HEADER_H + pad / 2 || sy > height - pad / 2) {
        centerOn(column, row)
      }
    },
    [centerOn]
  )

  const reveal = useCallback(
    (hash: string) => {
      const node = sceneRef.current.layout.nodeByHash.get(hash)
      if (node) revealAt(node.column, node.row)
    },
    [revealAt]
  )

  // Every animated zoom entry point takes over the view — stop a drag fling
  // first so the anchor point doesn't slide while the scale glides.
  const zoomStepAt = useCallback(
    (anchorX: number, anchorY: number, factor: number) => {
      panInertia.cancel()
      zoomAnim.zoomStep(anchorX, anchorY, factor)
    },
    [panInertia, zoomAnim]
  )

  useEffect(() => {
    controls.current = {
      zoomIn: () => zoomStepAt(sizeRef.current.width / 2, sizeRef.current.height / 2, 1.25),
      zoomOut: () => zoomStepAt(sizeRef.current.width / 2, sizeRef.current.height / 2, 0.8),
      fit,
      jumpToHead,
      reveal,
      revealAt
    }
    return () => {
      controls.current = null
    }
  }, [controls, zoomStepAt, fit, jumpToHead, reveal, revealAt])

  // Backing-store sizing, DPR-aware; re-runs on wrapper resize.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      const { width, height } = wrap.getBoundingClientRect()
      sizeRef.current = { width, height, dpr }
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      if (!initializedRef.current && sceneRef.current.layout.nodes.length > 0) {
        initializedRef.current = true
        jumpToHead()
      }
      clampView()
      // Setting canvas.width/height wipes the backing store to transparent.
      // ResizeObserver fires after layout but *before* paint (and after this
      // frame's rAF callbacks already ran), so a rAF-deferred draw would land
      // one frame late and the blank canvas would hit the screen — one white
      // flash per resize step, i.e. constant flicker while dragging a splitter.
      // Drawing synchronously here repaints the wiped store in the same frame.
      draw()
    })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [clampView, draw, jumpToHead])

  // First data landing after mount: frame the HEAD commit once.
  useEffect(() => {
    if (!initializedRef.current && layout.nodes.length > 0 && sizeRef.current.width > 0) {
      initializedRef.current = true
      jumpToHead()
    }
    clampView()
    invalidate()
  }, [layout, jumpToHead, clampView, invalidate])

  // Redraw on anything scene-visible; avatars invalidate as images land.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these values aren't read by invalidate — they're the intentional redraw triggers
  useEffect(invalidate, [
    selectedHash,
    selectedBranch,
    matches,
    activeHit,
    hitBranches,
    hitTags,
    wip,
    links,
    theme,
    invalidate
  ])
  useEffect(() => subscribeAvatars(invalidate), [invalidate])
  // The current hit's arrival ping: a short, FINITE rAF loop — it runs
  // PING_MS per target change and stops, so an idle graph burns zero frames.
  // Keyed on the hit's stable identity, not the object: the hits array is
  // rebuilt on every layout/search recompute and must not re-fire the ping.
  // Reduced-motion users get the steady glow with no ping.
  const activeHitKey = hitKey(activeHit)
  useEffect(() => {
    matchPulseRef.current = 1
    if (!activeHitKey) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    matchPulseRef.current = 0
    const start = performance.now()
    let raf = requestAnimationFrame(function tick() {
      matchPulseRef.current = Math.min(1, (performance.now() - start) / PING_MS)
      invalidate()
      if (matchPulseRef.current < 1) raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [activeHitKey, invalidate])
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme isn't read here — a theme change is the trigger to drop the palette cache and redraw
  useEffect(() => {
    paletteRef.current = null
    invalidate()
  }, [theme, invalidate])
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    []
  )

  const hitAt = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return null
    const view = viewRef.current
    const s = sceneRef.current
    return hitTest(
      s.layout,
      toWorldX(view, clientX - rect.left),
      toWorldY(view, clientY - rect.top),
      (row) => labelWidthFor(row.name),
      s.wip ? s.wip.column : null,
      s.wip ? s.wip.row : -1,
      // Match the renderer's sticky-label clamp so labels hit where they draw.
      toWorldX(view, 8),
      // Captions hit only while their layer shows (all-or-nothing by zoom)…
      captionAlpha(view.scale) > 0,
      // …and only over their actual glyphs, as measured at draw time.
      (node) => {
        const screenWidth = captionWidthFor(node.commit.hash)
        return screenWidth === undefined ? undefined : screenWidth / view.scale
      },
      // The caption band rides a screen-fixed gap below the capsule.
      view.scale
    )
  }, [])

  const setHover = useCallback(
    (hash: string | null, tip: Tooltip | null) => {
      if (hoverRef.current !== hash) {
        hoverRef.current = hash
        invalidate()
      }
      setTooltip((prev) => (prev?.node.commit.hash === tip?.node.commit.hash ? prev : tip))
    },
    [invalidate]
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (inTip(e)) return
    if (e.button !== 0 && e.button !== 1) return
    wrapRef.current?.focus()
    // Touching down catches a gliding fling — classic grab-to-stop.
    panInertia.cancel()
    // Seed the fling estimator with the grab point: a fast flick may dispatch
    // just one move event before release, and one sample can't make a velocity.
    panInertia.sample(e.clientX, e.clientY, e.timeStamp)
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, panned: false }
  }

  // The twin dot's own explanation, for the hover card: where else this
  // change lives. This line is what makes the dot self-teaching — one hover
  // answers "what's the purple dot?" — and each name is a jump target.
  // Computed per card, not per frame.
  const twinTargets = useMemo(() => {
    if (!tooltip) return []
    const targets: { name: string; node: GraphNode }[] = []
    for (const hash of twinHashes(links, tooltip.node.commit.hash)) {
      const twin = layout.nodeByHash.get(hash)
      if (!twin) continue
      const name = layout.rows.find((r) => r.chain === twin.chain)?.name
      if (name && !targets.some((t) => t.name === name)) targets.push({ name, node: twin })
    }
    return targets
  }, [tooltip, links, layout])

  /** True when the event happened inside the expanded-message card — it owns
   *  its own interactions (text selection, body scrolling). */
  const inTip = (e: { target: EventTarget }) =>
    (e.target as HTMLElement).closest?.('.graph-tip') != null

  const onPointerMove = (e: React.PointerEvent) => {
    if (inTip(e)) return
    const pan = panRef.current
    if (pan && pan.id === e.pointerId) {
      // Released off-window: buttons bitmask is the only reliable signal
      // (middle-button capture drops at the window edge, so the pointerup
      // never reached us). The flick that carried the cursor out must still
      // coast — fling from the velocity the drag had when the stream cut.
      if (e.buttons === 0) {
        panRef.current = null
        if (pan.panned) panInertia.releaseDetached()
        else panInertia.cancel()
        setCursor('default')
        return
      }
      const dx = e.clientX - pan.x
      const dy = e.clientY - pan.y
      if (!pan.panned && Math.abs(dx) + Math.abs(dy) > 3) {
        pan.panned = true
        // Grabbing the canvas takes over the view — freeze any zoom glide.
        zoomAnim.stop()
        wrapRef.current?.setPointerCapture(e.pointerId)
        setCursor('grabbing')
        setHover(null, null)
      }
      if (pan.panned) {
        panBy(dx, dy)
        // Feed the fling estimator. Chromium coalesces pointermove to one
        // dispatch per frame, so a fast flick is only a couple of events —
        // the coalesced list restores the raw samples (and their hardware
        // timestamps) the release-velocity estimate needs.
        const moves = e.nativeEvent.getCoalescedEvents?.() ?? []
        if (moves.length === 0) panInertia.sample(e.clientX, e.clientY, e.timeStamp)
        else for (const m of moves) panInertia.sample(m.clientX, m.clientY, m.timeStamp)
        pan.x = e.clientX
        pan.y = e.clientY
      }
      return
    }
    const hit = hitAt(e.clientX, e.clientY)
    if (hit?.type === 'node') {
      // Anchor the expansion card on the caption's exact glyph position, so
      // the truncated text appears to complete itself in place (captions and
      // the card's subject share one fixed on-screen font size).
      const view = viewRef.current
      setHover(hit.node.commit.hash, {
        x: (nodeX(hit.node.column) - NODE_R) * view.scale + view.x,
        // The caption's middle baseline rides a screen-fixed gap below the
        // capsule (see geometry.ts captionCenterOffset) — mirror it exactly.
        y: (nodeY(hit.node.row) + captionCenterOffset(view.scale)) * view.scale + view.y,
        node: hit.node
      })
      setCursor('pointer')
    } else {
      setHover(null, null)
      setCursor(hit ? 'pointer' : 'default')
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const pan = panRef.current
    panRef.current = null
    setCursor('default')
    if (!pan || pan.id !== e.pointerId) return
    if (pan.panned) {
      wrapRef.current?.releasePointerCapture(e.pointerId)
      // A flick keeps gliding; a parked release does nothing (pan.ts decides).
      panInertia.release()
      return
    }
    if (e.button !== 0) return
    const hit = hitAt(e.clientX, e.clientY)
    if (!hit) onSelectNode(null)
    else if (hit.type === 'node') onSelectNode(hit.node)
    else if (hit.type === 'wip') onWipClick()
    // A branch label or its container capsule opens the branch's changes.
    else onRowClick(hit.row)
  }

  // Touch input ends an aborted gesture with pointercancel, never pointerup
  // (e.g. the OS claims the touch). Without this the drag state would zombie
  // until the next pointerdown. The gesture was taken from the user, so the
  // view parks — no fling.
  const onPointerCancel = (e: React.PointerEvent) => {
    const pan = panRef.current
    if (!pan || pan.id !== e.pointerId) return
    panRef.current = null
    panInertia.cancel()
    setCursor('default')
  }

  const onContextMenu = (e: React.MouseEvent) => {
    if (inTip(e)) return
    e.preventDefault()
    const hit = hitAt(e.clientX, e.clientY)
    if (hit?.type === 'node') {
      onSelectNode(hit.node)
      onNodeMenu(hit.node, e.clientX, e.clientY)
    } else if (hit?.type === 'label' || hit?.type === 'row') {
      // Match the node behaviour: right-click selects what it targets (here,
      // opening the branch-changes view), so the menu always acts on the
      // thing the user is looking at.
      onRowClick(hit.row)
      onRowMenu(hit.row, e.clientX, e.clientY)
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (inTip(e)) return
    const hit = hitAt(e.clientX, e.clientY)
    if (hit?.type === 'label') onRowDoubleClick(hit.row)
    else if (!hit) {
      const rect = wrapRef.current?.getBoundingClientRect()
      if (rect) zoomStepAt(e.clientX - rect.left, e.clientY - rect.top, 1.4)
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    // Inside the expanded message the wheel scrolls its body, not the canvas.
    if (inTip(e)) return
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    // Any wheel input takes over the view from a running drag fling.
    panInertia.cancel()
    if (e.ctrlKey || e.metaKey) {
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      if (isDiscreteWheel(e.deltaY, e.deltaMode)) {
        // A mouse-wheel notch is one big step — glide toward it (zoom.ts).
        zoomAnim.zoomStep(x, y, wheelZoomFactor(e.deltaY, e.deltaMode))
      } else {
        // Trackpad pinch (Chromium reports it as ctrl+wheel): a smooth
        // stream of tiny deltas — apply 1:1, a glide would lag the fingers.
        zoomAt(x, y, Math.exp(-e.deltaY * 0.01))
      }
    } else {
      zoomAnim.stop()
      panBy(-e.deltaX, -e.deltaY)
      setTooltip(null)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = sceneRef.current
    if (e.key === 'Escape') {
      onSelectNode(null)
      return
    }
    // T: jump between a change and its twin on another line. twinHashes is
    // symmetric, so on a plain backport pair T bounces between the two ends;
    // the first in-window twin wins on longer chains.
    if (e.key === 't' || e.key === 'T') {
      const current = s.selectedHash ? s.layout.nodeByHash.get(s.selectedHash) : null
      if (!current) return
      const twin = twinHashes(s.links, current.commit.hash)
        .map((hash) => s.layout.nodeByHash.get(hash))
        .find((node) => node !== undefined)
      if (twin) {
        e.preventDefault()
        onSelectNode(twin)
        reveal(twin.commit.hash)
      }
      return
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoomStepAt(sizeRef.current.width / 2, sizeRef.current.height / 2, 1.25)
      return
    }
    if (e.key === '-') {
      e.preventDefault()
      zoomStepAt(sizeRef.current.width / 2, sizeRef.current.height / 2, 0.8)
      return
    }
    if (e.key === '0') {
      e.preventDefault()
      fit()
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const current = s.selectedHash ? s.layout.nodeByHash.get(s.selectedHash) : null
      if (current) {
        // Within the selected commit's branch: Home → its oldest commit,
        // End → its newest.
        const target = rowEndpoint(s.layout, current, e.key === 'Home' ? 'first' : 'last')
        onSelectNode(target)
        reveal(target.commit.hash)
      } else if (e.key === 'Home') {
        // Nothing selected: Home keeps its classic meaning — frame the
        // home changeset.
        jumpToHead()
      }
      return
    }
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown'
    ) {
      e.preventDefault()
      const current = s.selectedHash ? s.layout.nodeByHash.get(s.selectedHash) : null
      const head = s.layout.headHash ? s.layout.nodeByHash.get(s.layout.headHash) : null
      const target = current ? neighborNode(s.layout, current, e.key) : (head ?? s.layout.nodes[0])
      if (target) {
        onSelectNode(target)
        reveal(target.commit.hash)
      }
    }
  }

  return (
    <div
      ref={wrapRef}
      className="graph-canvas"
      style={{ cursor }}
      tabIndex={0}
      role="application"
      aria-label="Branch diagram"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => setHover(null, null)}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="graph-canvas__surface" />
      {tooltip && (
        <div
          className="graph-tip"
          // Baseline-aligned onto the caption's own glyphs (see tipPosition):
          // the truncated text completes itself in place, pixel for pixel.
          style={tipPosition(
            tooltip,
            wrapRef.current?.getBoundingClientRect(),
            paletteRef.current?.font ?? getComputedStyle(document.body).fontFamily
          )}
        >
          {/* The shared commit grammar (see CommitSummary.tsx): subject →
              meta → body. The subject is pixel-locked to the caption and the
              body shows in full — the two differences this context forces. */}
          <div className="graph-tip__subject">{tooltip.node.commit.subject}</div>
          <CommitMeta commit={tooltip.node.commit} />
          {twinTargets.length > 0 && (
            <div className="graph-tip__twins">
              <span>Also on</span>
              {twinTargets.map((target) => (
                <button
                  key={target.node.commit.hash}
                  type="button"
                  className="graph-tip__twin-link"
                  onClick={() => {
                    onSelectNode(target.node)
                    reveal(target.node.commit.hash)
                    setTooltip(null)
                  }}
                >
                  {target.name}
                </button>
              ))}
            </div>
          )}
          {stripCoAuthorTrailers(tooltip.node.commit.body) && (
            <div className="graph-tip__body">
              {/* Bodies come hard-wrapped at 72/80 columns; reflow joins the
                  wrapped paragraph lines so the card wraps them itself. */}
              {reflowMessage(stripCoAuthorTrailers(tooltip.node.commit.body))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
