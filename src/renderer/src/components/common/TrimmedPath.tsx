// A file path rendered as dim directory prefix + strong basename, with the
// prefix middle-trimmed **by measurement** so the basename always stays fully
// visible and sits flush after the ellipsis. CSS `text-overflow` can't do
// this: the browser drops the whole partially-clipped character and draws "…"
// where the last full one ended, leaving a ragged, row-varying gap between the
// ellipsis and the basename. Cutting the text itself (canvas-measured, binary
// search in pathTrim.ts) removes the gap entirely.
//
// The container's width must not depend on its content (e.g. `flex: 1`),
// otherwise trimming would shrink the container and re-trigger the observer.
//
// styles: primitives.css (.tpath)

import { type HTMLAttributes, useLayoutEffect, useRef, useState } from 'react'
import { splitPath } from '@/lib/format'
import { highlightMatch } from '@/lib/highlight'
import { trimDirToFit } from './pathTrim'

let sharedCtx: CanvasRenderingContext2D | null = null

/** measureText bound to the element's computed font and letter-spacing. */
function measurerFor(el: HTMLElement): (text: string) => number {
  sharedCtx ??= document.createElement('canvas').getContext('2d')
  const ctx = sharedCtx
  if (!ctx) return (text) => text.length * 8 // canvas unavailable: rough guess
  const cs = getComputedStyle(el)
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
  return (text) => ctx.measureText(text).width
}

interface Props extends HTMLAttributes<HTMLSpanElement> {
  /** Repo-relative path to display. */
  path: string
  /** Filter query to highlight inside both segments (see lib/highlight). */
  highlight?: string
  'data-tip'?: string
  'data-tip-overflow'?: string
}

export function TrimmedPath({
  path,
  highlight = '',
  className,
  'data-tip-overflow': tipOverflow,
  ...rest
}: Props) {
  const { dir, name } = splitPath(path)
  const ref = useRef<HTMLSpanElement>(null)
  const [dirText, setDirText] = useState(dir)

  // Fit before paint whenever the path changes (no flash while the virtual
  // list recycles rows), then re-fit on every container resize (panel drags).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const measure = measurerFor(el)
      // clientWidth rounds to whole px — the 1px slack keeps a rounded-up
      // width from pushing the fitted text a fraction over and clipping it.
      setDirText(trimDirToFit(dir, el.clientWidth - measure(name) - 1, measure))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dir, name])

  const trimmed = dirText !== dir
  return (
    <span
      ref={ref}
      className={className ? `tpath ${className}` : 'tpath'}
      // The tooltip layer's overflow gate detects CSS clipping, which never
      // happens once the text itself is cut to size — so drop the gate while
      // trimmed (the tip always shows) and keep it while the path fits.
      data-tip-overflow={trimmed ? undefined : tipOverflow}
      {...rest}
    >
      {dirText && <span className="tpath__dir">{highlightMatch(dirText, highlight)}</span>}
      <span className="tpath__name">{highlightMatch(name, highlight)}</span>
    </span>
  )
}
