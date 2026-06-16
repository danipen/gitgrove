import type { CSSProperties } from 'react'

import type { CommitPerson } from '@/lib/coauthors'
import { Avatar } from './Avatar'

interface Props {
  author: CommitPerson
  coAuthors: CommitPerson[]
  size?: number
}

/** Fraction of a disc left visible for each co-author peeking out behind. */
const PEEK_RATIO = 0.4
/** Air between discs once the fan is open. */
const FAN_GAP = 4

/**
 * The commit author with any co-authors tucked behind as a compact stack.
 * Hovering fans the discs open macOS-dock style — a staggered spring slide,
 * the disc under the cursor magnifying while its neighbours lean in — so each
 * avatar can be hovered for its own name + email tooltip. The container keeps
 * its collapsed footprint and the open fan floats above the row on a shadow,
 * so opening never reflows the text beside it (see `.avatar-fan` in
 * styles/features/history.css for the animation details).
 */
export function AvatarStack({ author, coAuthors, size = 28 }: Props) {
  if (coAuthors.length === 0) {
    return <Avatar name={author.name} email={author.email} size={size} />
  }
  const people = [author, ...coAuthors]
  const peek = Math.round(size * PEEK_RATIO)
  const collapsedWidth = size + (people.length - 1) * peek
  return (
    <span className="avatar-fan" style={{ width: collapsedWidth, height: size }}>
      {people.map((person, i) => (
        <span
          key={`${person.email}|${person.name}`}
          className="avatar-fan__item"
          style={
            {
              // Author in front, each co-author one layer further back; the
              // open/close stagger reads the index (and its reverse) in CSS.
              '--z': people.length - i,
              '--i': i,
              '--rev': people.length - 1 - i,
              '--x': `${i * peek}px`,
              '--fan-x': `${i * (size + FAN_GAP)}px`
            } as CSSProperties
          }
        >
          <Avatar name={person.name} email={person.email} size={size} />
        </span>
      ))}
    </span>
  )
}
