import type { ChangedFile, Commit } from '@shared/types'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { coAuthorsOf, stripCoAuthorTrailers } from '@/lib/coauthors'
import { type CommitRef, parseRefs, pluralize } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { AvatarStack } from './AvatarStack'

/** Refs shown before a "+N" expander appears (the pane is wide, so allow a few). */
const MAX_SUMMARY_REFS = 6

export function RefChip({ refItem }: { refItem: CommitRef }) {
  return (
    <span
      className={`ref-chip${refItem.isTag ? ' ref-chip--tag' : ''}`}
      data-tip={refItem.name}
      data-tip-overflow=""
    >
      {refItem.name}
    </span>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      className={`copy-btn${copied ? ' is-copied' : ''}`}
      title={copied ? 'Copied!' : label}
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => setCopied(true))
      }}
    >
      {copied ? <Icon.Check size={13} /> : <Icon.Copy size={13} />}
    </button>
  )
}

/** The commit's body, collapsed to a few lines with a "Show more" toggle once
 *  it overflows. Render with `key={commit.hash}` (or under a keyed parent) so
 *  a selection change remounts it — that resets the collapse state and lets
 *  the overflow probe measure a fresh, collapsed layout. */
export function CommitBody({ commit }: { commit: Commit }) {
  // Co-authors render as the avatar stack + byline; their trailer lines would
  // only repeat that, so the displayed body drops them.
  const body = stripCoAuthorTrailers(commit.body)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el) setOverflows(el.scrollHeight - el.clientHeight > 2)
  }, [])

  if (!body) return null
  return (
    <div className="commit-summary__body-wrap">
      <div ref={bodyRef} className={`commit-summary__body${expanded ? ' is-expanded' : ''}`}>
        {body}
      </div>
      {(overflows || expanded) && (
        <button className="link-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

export function DiffStat({ files }: { files: ChangedFile[] }) {
  let insertions = 0
  let deletions = 0
  for (const f of files) {
    insertions += f.insertions ?? 0
    deletions += f.deletions ?? 0
  }
  if (insertions === 0 && deletions === 0) return null
  return (
    <span className="diff-stat">
      <span className="diff-stat__add">+{insertions}</span>
      <span className="diff-stat__del">−{deletions}</span>
    </span>
  )
}

interface Props {
  commit: Commit
  files: ChangedFile[]
  filesLoading: boolean
}

// Rendered with `key={commit.hash}` so it remounts per commit — that resets the
// collapse state and lets the body-overflow probe measure a fresh, collapsed
// layout without effect-ordering races.
export function CommitSummary({ commit, files, filesLoading }: Props) {
  const refs = parseRefs(commit.refs)
  const coAuthors = coAuthorsOf(commit)
  const [refsExpanded, setRefsExpanded] = useState(false)

  const visibleRefs = refsExpanded ? refs : refs.slice(0, MAX_SUMMARY_REFS)
  const hiddenRefs = refs.length - MAX_SUMMARY_REFS

  return (
    <div className="commit-summary">
      <div className="commit-summary__row">
        <AvatarStack
          author={{ name: commit.authorName, email: commit.authorEmail }}
          coAuthors={coAuthors}
          size={34}
        />
        <div className="commit-summary__head">
          <div className="commit-summary__subject" data-tip={commit.subject} data-tip-overflow="">
            {commit.subject}
          </div>
          <div className="commit-summary__byline">
            <span className="commit-summary__author">{commit.authorName}</span>
            {coAuthors.length > 0 && (
              <span>
                and {coAuthors.length === 1 ? coAuthors[0].name : `${coAuthors.length} others`}
              </span>
            )}
            <span data-tip={new Date(commit.date).toLocaleString()}>
              committed {commit.relativeDate}
            </span>
          </div>
        </div>
        <div className="commit-summary__meta">
          <span className="commit-summary__sha">
            <span className="commit__hash">{commit.shortHash}</span>
            <CopyButton value={commit.hash} label="Copy commit SHA" />
          </span>
          <span className="commit-summary__stats">
            {!filesLoading && <DiffStat files={files} />}
            <span className="commit-summary__count">
              {filesLoading ? 'Loading…' : pluralize(files.length, 'file')}
            </span>
          </span>
        </div>
      </div>

      <CommitBody commit={commit} />

      {refs.length > 0 && (
        <div className="commit-summary__refs">
          {visibleRefs.map((ref) => (
            <RefChip key={ref.name} refItem={ref} />
          ))}
          {hiddenRefs > 0 && (
            <button
              className="ref-chip ref-chip--more ref-chip--toggle"
              onClick={() => setRefsExpanded((v) => !v)}
            >
              {refsExpanded ? 'Show less' : `+${hiddenRefs}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
