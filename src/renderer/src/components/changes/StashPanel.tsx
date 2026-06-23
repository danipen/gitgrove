// The stash entry point above the composer: a chip with the stash count that
// opens a filterable popover (arrows + Enter navigate), where each stash can
// be reviewed (diff dialog), applied, popped or dropped. Renders nothing when
// the repo has no stashes.

import type { StashEntry } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ClearButton } from '@/components/common/ClearButton'
import { Popover } from '@/components/common/Popover'
import { pluralize, stashLabel } from '@/lib/format'
import { highlightMatch } from '@/lib/highlight'
import { Icon } from '@/lib/icons'
import type { ResolvedTheme } from '@/lib/theme'
import { useListKeyNav } from '@/lib/useListKeyNav'
import { StashReviewDialog } from './StashReviewDialog'

interface Props {
  repoPath: string
  stashes: StashEntry[]
  busy: boolean
  /** Resolved theme, for the review dialog's diff. */
  theme: ResolvedTheme
  /** Run a mutating op (serialized, auto-refresh, errors → toast). */
  runOp: (fn: () => Promise<unknown>) => Promise<boolean>
}

export function StashPanel({ repoPath, stashes, busy, theme, runOp }: Props) {
  const gg = window.gitgrove

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [reviewStash, setReviewStash] = useState<StashEntry | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter is only worth the vertical space once the list grows past a glance.
  const filterable = stashes.length > 5
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return stashes
    return stashes.filter((s) => stashLabel(s).toLowerCase().includes(q))
  }, [stashes, query])

  // Arrows move through the stashes, Enter opens the highlighted one's review.
  const nav = useListKeyNav({
    enabled: open,
    count: visible.length,
    onActivate: (i) => {
      const s = visible[i]
      if (!s) return
      setOpen(false)
      setReviewStash(s)
    },
    onHighlight: (i) =>
      listRef.current?.querySelectorAll('.stash-item')[i]?.scrollIntoView({ block: 'nearest' })
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter change is the intentional trigger; setIndex is stable.
  useEffect(() => nav.setIndex(0), [query])

  if (stashes.length === 0) return null

  return (
    <>
      <div className="composer-head">
        <span className="changes__stash-spacer" />
        <button
          ref={anchor}
          className="stash-chip"
          disabled={busy}
          data-tip="Review stashes"
          onClick={() => setOpen(true)}
        >
          <Icon.Stash size={14} />
          {pluralize(stashes.length, 'stash').replace('stashs', 'stashes')}
        </button>
      </div>

      <Popover
        anchor={anchor.current}
        open={open}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
        width={320}
      >
        {filterable ? (
          <div className="popover__search">
            <input
              data-autofocus=""
              placeholder="Filter stashes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query !== '' && <ClearButton label="Clear filter" onClear={() => setQuery('')} />}
          </div>
        ) : (
          <div className="popover__group-label" style={{ position: 'static' }}>
            Stashes
          </div>
        )}
        <div className="stash-list" ref={listRef}>
          {visible.length === 0 ? (
            <div className="popover__empty">No matching stashes</div>
          ) : (
            visible.map((s, i) => (
              <div key={s.index} className={`stash-item${i === nav.index ? ' is-kbd' : ''}`}>
                <button
                  type="button"
                  className="stash-item__main"
                  data-tip="Review this stash"
                  onClick={() => {
                    setOpen(false)
                    setReviewStash(s)
                  }}
                >
                  <span className="stash-item__msg" data-tip-overflow="">
                    {highlightMatch(stashLabel(s), query)}
                  </span>
                  <span className="stash-item__date">{s.relativeDate}</span>
                </button>
                <div className="stash-item__actions">
                  {/* Auto-stashes are GitGrove's own bookkeeping ("changes
                      left on …"): applying while keeping the entry would
                      leave a stale welcome-back reminder promising changes
                      that are already back — so the only offer is Restore
                      (apply + clear), mirroring the reminder banner. */}
                  {s.auto ? (
                    <button
                      className="section-head__action"
                      data-tip="Apply and clear the stash"
                      onClick={() => {
                        setOpen(false)
                        runOp(() => gg.stashApply(repoPath, s.index, true))
                      }}
                    >
                      Restore
                    </button>
                  ) : (
                    <>
                      <button
                        className="section-head__action"
                        data-tip="Apply and keep"
                        onClick={() => {
                          setOpen(false)
                          runOp(() => gg.stashApply(repoPath, s.index, false))
                        }}
                      >
                        Apply
                      </button>
                      <button
                        className="section-head__action"
                        data-tip="Apply and delete"
                        onClick={() => {
                          setOpen(false)
                          runOp(() => gg.stashApply(repoPath, s.index, true))
                        }}
                      >
                        Pop
                      </button>
                    </>
                  )}
                  <button
                    className="section-head__action is-danger"
                    data-tip="Delete stash"
                    onClick={() => {
                      setOpen(false)
                      runOp(() => gg.stashDrop(repoPath, s.index))
                    }}
                  >
                    <Icon.Trash size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </Popover>

      {reviewStash && (
        <StashReviewDialog
          repoPath={repoPath}
          stash={reviewStash}
          theme={theme}
          onApply={(pop) => {
            setReviewStash(null)
            runOp(() => gg.stashApply(repoPath, reviewStash.index, pop))
          }}
          onDrop={() => {
            setReviewStash(null)
            runOp(() => gg.stashDrop(repoPath, reviewStash.index))
          }}
          onClose={() => setReviewStash(null)}
        />
      )}
    </>
  )
}
