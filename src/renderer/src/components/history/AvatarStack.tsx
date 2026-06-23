import { type CSSProperties, useCallback, useRef } from 'react'

import type { CommitPerson } from '@/lib/coauthors'
import { Avatar } from './Avatar'

interface Props {
  author: CommitPerson
  coAuthors: CommitPerson[]
  size?: number
}

/** Fraction of a disc left visible for each co-author peeking out behind. Kept
 *  tight so a stacked commit stays compact — the discs overlap heavily and only
 *  spread apart on hover (the fan). */
const PEEK_RATIO = 0.35
/** Air between discs once the fan is open. */
const FAN_GAP = 4
/** Peak magnification of the disc directly under the cursor (1.3 = +30%). */
const MAX_SCALE = 1.2
/** Discs shown before the rest collapse into a "+N" counter. A squashed commit
 *  can list dozens of `Co-authored-by:` trailers; without a cap the stack runs
 *  off the row (GitHub Desktop shows only the author for those). The last slot
 *  becomes the counter, so author + (MAX_DISCS - 2) co-authors stay visible. */
const MAX_DISCS = 4

export interface FanPlan {
  /** People that each get their own avatar disc, author first. */
  shown: CommitPerson[]
  /** How many people collapse into the trailing "+N" counter (0 = none). */
  overflow: number
}

/**
 * Decide how a list of people fills the fan: everyone gets a disc until there
 * are more than `max`, at which point the last slot becomes a "+N" counter for
 * the remainder (so author + `max - 2` co-authors stay visible). Pure so the
 * cap is unit-tested without a DOM.
 */
export function planFan(people: CommitPerson[], max = MAX_DISCS): FanPlan {
  const overflow = people.length > max ? people.length - (max - 1) : 0
  return { shown: overflow ? people.slice(0, max - 1) : people, overflow }
}

/** The five CSS custom properties that place disc `i` of `slots` in the fan. */
function fanVars(i: number, slots: number, size: number, peek: number): CSSProperties {
  return {
    // Author in front, each co-author one layer further back; the open/close
    // stagger reads the index (and its reverse) in CSS.
    '--z': slots - i,
    '--i': i,
    '--rev': slots - 1 - i,
    '--x': `${i * peek}px`,
    '--fan-x': `${i * (size + FAN_GAP)}px`
  } as CSSProperties
}

/**
 * The commit author with any co-authors tucked behind as a compact stack.
 * Hovering fans the discs open macOS-dock style — a staggered spring slide,
 * then continuous magnification: each disc grows with how close the cursor is
 * to it (driven by `--mag`, see below), so it tracks the pointer smoothly
 * instead of snapping between sizes. Every disc can be hovered for its own name
 * + email tooltip. The container keeps its collapsed footprint and the open fan
 * floats above the row on a shadow, so opening never reflows the text beside it
 * (see `.avatar-fan` in styles/features/history.css for the animation details).
 */
export function AvatarStack({ author, coAuthors, size = 28 }: Props) {
  // Continuous dock magnification: on each move we set every disc's `--mag`
  // (and stacking) from a Gaussian of the cursor's distance to its centre. A
  // pair gets a wide influence so the neighbour leans in too; three or more use
  // a tight one, so only the disc under the cursor grows — overlapping discs all
  // swelling at once just reads as mush. Positions come from the same layout
  // maths as the CSS (`i * (size + FAN_GAP)`), so no per-frame DOM measuring.
  const fanRef = useRef<HTMLSpanElement>(null)
  const magnify = useCallback(
    (clientX: number) => {
      const fan = fanRef.current
      if (!fan) return
      const items = fan.children
      const x = clientX - fan.getBoundingClientRect().left
      const sigma = items.length <= 2 ? size + FAN_GAP : size * 0.5
      for (let i = 0; i < items.length; i++) {
        const center = i * (size + FAN_GAP) + size / 2
        const d = x - center
        const mag = 1 + (MAX_SCALE - 1) * Math.exp(-(d * d) / (2 * sigma * sigma))
        const item = items[i] as HTMLElement
        item.style.setProperty('--mag', mag.toFixed(3))
        // Bigger disc rides on top, so the magnified one is never clipped by its
        // neighbours; cleared on leave so the resting --z stacking returns.
        item.style.zIndex = String(100 + Math.round(mag * 100))
      }
    },
    [size]
  )
  const reset = useCallback(() => {
    const fan = fanRef.current
    if (!fan) return
    for (const item of Array.from(fan.children) as HTMLElement[]) {
      item.style.removeProperty('--mag')
      item.style.zIndex = ''
    }
  }, [])

  if (coAuthors.length === 0) {
    return <Avatar name={author.name} email={author.email} size={size} />
  }
  // Cap the discs: past MAX_DISCS the trailing slot is a "+N" counter instead of
  // an avatar, so the stack keeps a fixed width no matter how many co-authors a
  // (squashed) commit lists. Below the cap, every person still gets a disc.
  const { shown, overflow } = planFan([author, ...coAuthors])
  const slots = shown.length + (overflow ? 1 : 0)
  const peek = Math.round(size * PEEK_RATIO)
  const collapsedWidth = size + (slots - 1) * peek
  return (
    <span
      className="avatar-fan"
      style={{ width: collapsedWidth, height: size }}
      ref={fanRef}
      onMouseMove={(e) => magnify(e.clientX)}
      onMouseLeave={reset}
    >
      {shown.map((person, i) => (
        <span
          key={`${person.email}|${person.name}`}
          className="avatar-fan__item"
          style={fanVars(i, slots, size, peek)}
        >
          <Avatar name={person.name} email={person.email} size={size} />
        </span>
      ))}
      {overflow > 0 && (
        <span className="avatar-fan__item" style={fanVars(shown.length, slots, size, peek)}>
          <span
            className="avatar avatar--more"
            style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
            data-tip={`+${overflow} more co-authors`}
          >
            +{overflow}
          </span>
        </span>
      )}
    </span>
  )
}
