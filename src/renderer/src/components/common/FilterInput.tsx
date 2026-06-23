// A plain text filter bar — the same look as the file-list filter, minus the
// status chips — for filtering a list by free text. Used by the History tab and
// the File History overlay to filter their commit lists. Shows a spinner while
// a (server-side) filter is in flight, and a clear "×" once it has text.
// styles: primitives.css (.list-filter)

import { ClearButton } from './ClearButton'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Show a spinner instead of the clear button while results are loading. */
  busy?: boolean
}

export function FilterInput({ value, onChange, placeholder, busy = false }: Props) {
  return (
    <div className="list-filter">
      <input
        className="list-filter__input"
        type="text"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {busy ? (
        <span className="input-spin" aria-hidden="true">
          <span className="spinner spinner--sm" />
        </span>
      ) : (
        value !== '' && <ClearButton label="Clear filter" onClear={() => onChange('')} />
      )}
    </div>
  )
}
