// Hover state for the Graph's PR chips: which row's PR hovercard is open and
// where its chip sits on screen. Same timing grammar as the branch switcher's
// badge (BranchSwitcher BranchPrBadges): a short hover delay to open, and once
// open the card's own pointer tracking owns the close, so the pointer can
// travel from the chip into the card without it vanishing.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrCardAnchor } from '@/components/common/PrHoverCard'
import type { GraphRow } from './layout'

/** Delay before a hovered chip opens its card, and the grace before a card the
 *  pointer left closes — the switcher badge's values. */
const OPEN_DELAY_MS = 120
const CLOSE_GRACE_MS = 200

export interface OpenPrCard {
  row: GraphRow
  /** The chip's on-screen rect, frozen at open time (any pan or zoom closes). */
  anchor: PrCardAnchor
}

export function usePrCard() {
  const [card, setCard] = useState<OpenPrCard | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The chip under the pointer right now (by chain), so re-hovering the same
   *  chip on every pointermove doesn't restart the open delay. */
  const hoveredChain = useRef<number | null>(null)

  const keepOpen = useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = undefined
  }, [])

  const requestClose = useCallback(() => {
    if (closeTimer.current) return
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setCard(null)
    }, CLOSE_GRACE_MS)
  }, [])

  /** Close now — the view moved, the card was used, or Escape. */
  const close = useCallback(() => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    closeTimer.current = undefined
    hoveredChain.current = null
    setCard(null)
  }, [])

  /** The pointer is over `row`'s chip, whose screen rect `rect()` resolves. */
  const hoverChip = useCallback(
    (row: GraphRow, rect: () => DOMRect) => {
      keepOpen()
      if (hoveredChain.current === row.chain) return
      hoveredChain.current = row.chain
      clearTimeout(openTimer.current)
      openTimer.current = setTimeout(() => {
        const frozen = rect()
        setCard({ row, anchor: { getBoundingClientRect: () => frozen } })
      }, OPEN_DELAY_MS)
    },
    [keepOpen]
  )

  /** The pointer left every chip: cancel a not-yet-open card. An open one
   *  stays — its tracking effect decides (the pointer may be heading in). */
  const leaveChip = useCallback(() => {
    if (hoveredChain.current === null) return
    hoveredChain.current = null
    clearTimeout(openTimer.current)
  }, [])

  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    []
  )

  return { card, hoverChip, leaveChip, keepOpen, requestClose, close }
}
