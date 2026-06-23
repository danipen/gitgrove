// Reusable file-list filter: a text input (path substring) plus colored
// status-letter chips. Used by the Changes sidebar and by History's
// commit-files panel so both lists filter the same way.

import type { ChangedFile, FileStatus } from '@shared/types'
import { useCallback, useMemo, useState } from 'react'
import { statusLabel } from '@/lib/format'
import { ClearButton } from './ClearButton'

export const DEFAULT_FILTER_TYPES: readonly FileStatus[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked'
]

interface FileFilterResult {
  /** The files passing the current filter (input array when inactive). */
  filtered: ChangedFile[]
  /** The current path query (trimmed-or-not as typed) — for match highlighting. */
  query: string
  /** True when a query or type filter is set. */
  active: boolean
  /** The rendered filter bar. */
  bar: React.ReactNode
  /** Clear query and type chips (e.g. when the underlying list changes). */
  reset: () => void
}

/** Filter state + bar for a ChangedFile list. `types` picks the chips shown. */
export function useFileFilter(
  files: ChangedFile[],
  types: readonly FileStatus[] = DEFAULT_FILTER_TYPES
): FileFilterResult {
  const [query, setQuery] = useState('')
  const [rawTypeFilter, setTypeFilter] = useState<ReadonlySet<FileStatus>>(new Set())

  // A chip can disappear while selected (e.g. the Conflicted chip once the
  // last conflict is resolved) — drop hidden selections so the list never
  // stays filtered by something the user can no longer see or unselect.
  const typeFilter = useMemo(
    () => new Set([...rawTypeFilter].filter((t) => types.includes(t))),
    [rawTypeFilter, types]
  )

  const toggleType = (t: FileStatus) =>
    setTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })

  const reset = useCallback(() => {
    setQuery('')
    setTypeFilter(new Set())
  }, [])

  const active = query.trim() !== '' || typeFilter.size > 0
  const filtered = useMemo(() => {
    if (!active) return files
    const q = query.trim().toLowerCase()
    return files.filter(
      (f) =>
        (q === '' || f.path.toLowerCase().includes(q)) &&
        (typeFilter.size === 0 || typeFilter.has(f.status))
    )
  }, [files, active, query, typeFilter])

  const bar = (
    <div className="wfl-filter">
      <div className="wfl-filter__field">
        <input
          className="wfl-filter__input"
          placeholder="Filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query !== '' && <ClearButton label="Clear filter" onClear={() => setQuery('')} />}
      </div>
      {types.map((t) => (
        <button
          key={t}
          type="button"
          className={`wfl-filter__chip st-${t}${typeFilter.has(t) ? ' is-active' : ''}`}
          data-tip={statusLabel(t)}
          onClick={() => toggleType(t)}
        >
          {t[0].toUpperCase()}
        </button>
      ))}
    </div>
  )

  return { filtered, query, active, bar, reset }
}
