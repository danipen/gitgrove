// The Graph tab's filter bar: branch / author / date filters plus the search
// box with match navigation. Filters are instant — branch filtering re-lays
// the diagram out, author/search filtering dims non-matching nodes — and every
// filterable list highlights why a row matched (lib/highlight).
// styles: styles/features/graph.css

import { useMemo, useRef, useState } from 'react'
import { Popover } from '@/components/common/Popover'
import { highlightMatch } from '@/lib/highlight'
import { Icon } from '@/lib/icons'

export type DatePresetId = 'week' | 'month' | 'quarter' | 'year' | 'all'

export const DATE_PRESETS: { id: DatePresetId; label: string; since: string | null }[] = [
  { id: 'week', label: 'Last week', since: '1 week ago' },
  { id: 'month', label: 'Last month', since: '1 month ago' },
  { id: 'quarter', label: 'Last 3 months', since: '3 months ago' },
  { id: 'year', label: 'Last year', since: '1 year ago' },
  { id: 'all', label: 'All time', since: null }
]

/** Hop depths for the Focus lens: how far relatedness spreads from the seed. */
const FOCUS_HOPS: { hops: number; label: string }[] = [
  { hops: 1, label: 'Direct relatives' },
  { hops: 2, label: 'Extended family · 2 hops' },
  { hops: 3, label: 'Neighborhood · 3 hops' }
]

export interface AuthorOption {
  name: string
  /** Lowercased email — the filter's identity key. */
  email: string
  commits: number
}

interface Props {
  branches: string[]
  branchFilter: ReadonlySet<string> | null
  onBranchFilter: (next: Set<string> | null) => void
  authors: AuthorOption[]
  authorFilter: ReadonlySet<string> | null
  onAuthorFilter: (next: Set<string> | null) => void
  datePreset: DatePresetId
  onDatePreset: (preset: DatePresetId) => void
  /** Keep only structure-shaping commits (collapse linear runs). */
  structureOnly: boolean
  onStructureOnly: (value: boolean) => void
  /** Omit branches already merged into another branch. */
  hideMerged: boolean
  onHideMerged: (value: boolean) => void
  /** Hide the backport twin dots (marking is on unless hidden). */
  hideTwins: boolean
  onHideTwins: (value: boolean) => void
  /** Active Focus lens (seed branch + hop depth), or null. */
  focus: { name: string; hops: number } | null
  onFocusHops: (hops: number) => void
  onExitFocus: () => void
  search: string
  onSearch: (query: string) => void
  /** Search hits: total and the 0-based current one (-1 when none active). */
  matchCount: number
  matchIndex: number
  onMatchStep: (dir: 1 | -1) => void
}

/** A filter chip button: label plus an "engaged" count, opens its popover. */
function Chip({
  label,
  value,
  active,
  onClick,
  refCb
}: {
  label: string
  value: string | null
  active: boolean
  onClick: () => void
  refCb: (el: HTMLButtonElement | null) => void
}) {
  return (
    <button
      ref={refCb}
      type="button"
      className={`graph-chip${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      {label}
      {value && <span className="graph-chip__value">{value}</span>}
      <Icon.Chevron size={12} />
    </button>
  )
}

/** Shared checkbox-list picker used by the branch and author filters. */
function Picker<T extends { id: string; label: string; hint?: string }>({
  items,
  selected,
  onChange,
  placeholder
}: {
  items: T[]
  selected: ReadonlySet<string> | null
  onChange: (next: Set<string> | null) => void
  placeholder: string
}) {
  const [query, setQuery] = useState('')
  const q = query.trim()
  const visible = useMemo(
    () => (q === '' ? items : items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()))),
    [items, q]
  )
  const toggle = (id: string) => {
    const next = new Set(selected ?? items.map((i) => i.id))
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next.size === items.length ? null : next)
  }
  const only = (id: string) => onChange(items.length === 1 ? null : new Set([id]))
  return (
    <div className="graph-picker">
      <div className="list-filter">
        <input
          className="list-filter__input"
          data-autofocus
          type="text"
          placeholder={placeholder}
          aria-label={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="graph-picker__list">
        {visible.length === 0 && <div className="list-empty">No matches.</div>}
        {visible.map((item) => (
          <label key={item.id} className="graph-picker__item">
            <input
              type="checkbox"
              checked={selected === null || selected.has(item.id)}
              onChange={() => toggle(item.id)}
            />
            <span className="graph-picker__label">{highlightMatch(item.label, q)}</span>
            <button
              type="button"
              className="graph-picker__only"
              onClick={(e) => {
                // A label's default click would also toggle the checkbox.
                e.preventDefault()
                only(item.id)
              }}
            >
              only
            </button>
            {item.hint && <span className="graph-picker__hint">{item.hint}</span>}
          </label>
        ))}
      </div>
      <div className="graph-picker__foot">
        <button
          type="button"
          className="link-toggle"
          disabled={selected === null}
          onClick={() => onChange(null)}
        >
          Select all
        </button>
      </div>
    </div>
  )
}

export function GraphToolbar({
  branches,
  branchFilter,
  onBranchFilter,
  authors,
  authorFilter,
  onAuthorFilter,
  datePreset,
  onDatePreset,
  structureOnly,
  onStructureOnly,
  hideMerged,
  onHideMerged,
  hideTwins,
  onHideTwins,
  focus,
  onFocusHops,
  onExitFocus,
  search,
  onSearch,
  matchCount,
  matchIndex,
  onMatchStep
}: Props) {
  const [open, setOpen] = useState<'branches' | 'authors' | 'date' | 'view' | 'focus' | null>(null)
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({})
  const anchorFor = (id: string) => (el: HTMLButtonElement | null) => {
    anchors.current[id] = el
  }
  const close = () => setOpen(null)
  const searching = search.trim() !== ''

  const branchItems = useMemo(() => branches.map((b) => ({ id: b, label: b })), [branches])
  const authorItems = useMemo(
    () => authors.map((a) => ({ id: a.email, label: a.name, hint: `${a.commits}` })),
    [authors]
  )

  return (
    <div className="graph-toolbar">
      <Chip
        label="Branches"
        value={branchFilter ? `${branchFilter.size}` : null}
        active={open === 'branches' || branchFilter !== null}
        onClick={() => setOpen(open === 'branches' ? null : 'branches')}
        refCb={anchorFor('branches')}
      />
      <Chip
        label="Authors"
        value={authorFilter ? `${authorFilter.size}` : null}
        active={open === 'authors' || authorFilter !== null}
        onClick={() => setOpen(open === 'authors' ? null : 'authors')}
        refCb={anchorFor('authors')}
      />
      <Chip
        label={DATE_PRESETS.find((p) => p.id === datePreset)?.label ?? 'All time'}
        value={null}
        active={open === 'date' || datePreset !== 'all'}
        onClick={() => setOpen(open === 'date' ? null : 'date')}
        refCb={anchorFor('date')}
      />
      <Chip
        label="View"
        value={(() => {
          const engaged = Number(structureOnly) + Number(hideMerged) + Number(hideTwins)
          return engaged > 0 ? `${engaged}` : null
        })()}
        active={open === 'view' || structureOnly || hideMerged || hideTwins}
        onClick={() => setOpen(open === 'view' ? null : 'view')}
        refCb={anchorFor('view')}
      />

      {focus && (
        <div className="graph-chip is-active graph-focus">
          <button
            ref={anchorFor('focus')}
            type="button"
            className="graph-focus__seed"
            onClick={() => setOpen(open === 'focus' ? null : 'focus')}
          >
            <Icon.Focus size={13} />
            {focus.name}
            <span className="graph-chip__value">
              {focus.hops === 1 ? '1 hop' : `${focus.hops} hops`}
            </span>
            <Icon.Chevron size={12} />
          </button>
          <button
            type="button"
            className="graph-focus__exit"
            aria-label="Exit focus"
            data-tip="Exit focus (Esc)"
            onClick={onExitFocus}
          >
            <Icon.Close size={12} />
          </button>
        </div>
      )}

      <div className={`graph-search${searching ? ' is-active' : ''}`}>
        <Icon.Search size={13} />
        <input
          type="text"
          placeholder="Find commits…"
          aria-label="Find commits"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matchCount > 0) onMatchStep(e.shiftKey ? -1 : 1)
            if (e.key === 'Escape') onSearch('')
          }}
        />
        {searching && (
          <>
            <span className="graph-search__count">
              {matchCount === 0 ? '0' : `${matchIndex + 1}/${matchCount}`}
            </span>
            <button
              type="button"
              className="icon-btn graph-search__step"
              aria-label="Previous match"
              disabled={matchCount === 0}
              onClick={() => onMatchStep(-1)}
            >
              <Icon.Prev size={12} />
            </button>
            <button
              type="button"
              className="icon-btn graph-search__step"
              aria-label="Next match"
              disabled={matchCount === 0}
              onClick={() => onMatchStep(1)}
            >
              <Icon.Next size={12} />
            </button>
          </>
        )}
      </div>

      <Popover
        anchor={anchors.current.branches ?? null}
        open={open === 'branches'}
        onClose={close}
        width={280}
      >
        <Picker
          items={branchItems}
          selected={branchFilter}
          onChange={onBranchFilter}
          placeholder="Filter branches…"
        />
      </Popover>
      <Popover
        anchor={anchors.current.authors ?? null}
        open={open === 'authors'}
        onClose={close}
        width={300}
      >
        <Picker
          items={authorItems}
          selected={authorFilter}
          onChange={onAuthorFilter}
          placeholder="Filter authors…"
        />
      </Popover>
      <Popover
        anchor={anchors.current.date ?? null}
        open={open === 'date'}
        onClose={close}
        width={200}
      >
        <div className="graph-picker__list" role="menu">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="menuitemradio"
              aria-checked={preset.id === datePreset}
              className={`graph-picker__preset${preset.id === datePreset ? ' is-active' : ''}`}
              onClick={() => {
                onDatePreset(preset.id)
                close()
              }}
            >
              {preset.id === datePreset ? (
                <Icon.Check size={13} />
              ) : (
                <span className="graph-picker__spacer" />
              )}
              {preset.label}
            </button>
          ))}
        </div>
      </Popover>
      <Popover
        anchor={anchors.current.focus ?? null}
        open={open === 'focus'}
        onClose={close}
        width={230}
      >
        <div className="graph-picker__list" role="menu">
          {FOCUS_HOPS.map((option) => (
            <button
              key={option.hops}
              type="button"
              role="menuitemradio"
              aria-checked={option.hops === focus?.hops}
              className={`graph-picker__preset${option.hops === focus?.hops ? ' is-active' : ''}`}
              onClick={() => {
                onFocusHops(option.hops)
                close()
              }}
            >
              {option.hops === focus?.hops ? (
                <Icon.Check size={13} />
              ) : (
                <span className="graph-picker__spacer" />
              )}
              {option.label}
            </button>
          ))}
        </div>
      </Popover>
      <Popover
        anchor={anchors.current.view ?? null}
        open={open === 'view'}
        onClose={close}
        width={320}
      >
        <div className="graph-picker">
          <label className="graph-picker__opt">
            <input
              type="checkbox"
              checked={structureOnly}
              onChange={(e) => onStructureOnly(e.target.checked)}
            />
            <span>
              <span className="graph-picker__opt-title">Structure only</span>
              <span className="graph-picker__opt-desc">
                Show only the commits that shape the diagram — branch starts and tips, merges, tags
                — and collapse the linear runs between them.
              </span>
            </span>
          </label>
          <label className="graph-picker__opt">
            <input
              type="checkbox"
              checked={hideMerged}
              onChange={(e) => onHideMerged(e.target.checked)}
            />
            <span>
              <span className="graph-picker__opt-title">Hide merged branches</span>
              <span className="graph-picker__opt-desc">
                Omit branches already merged into another branch. The current and default branches
                always show.
              </span>
            </span>
          </label>
          <label className="graph-picker__opt">
            <input
              type="checkbox"
              checked={hideTwins}
              onChange={(e) => onHideTwins(e.target.checked)}
            />
            <span>
              <span className="graph-picker__opt-title">Hide backport twins</span>
              <span className="graph-picker__opt-desc">
                Omit the purple dots marking changes that live on more than one line — a fix on the
                mainline and its cherry-picked copy on a release line. Hover a dotted commit to see
                its twins; click a branch name or press T to jump.
              </span>
            </span>
          </label>
        </div>
      </Popover>
    </div>
  )
}
