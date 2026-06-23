// A plain text filter bar — the same look as the file-list filter, minus the
// status chips — for filtering a list by free text. Used by the History tab and
// the File History overlay to filter their commit lists.
// styles: primitives.css (.list-filter)

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder: string
}

export function FilterInput({ value, onChange, placeholder }: Props) {
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
    </div>
  )
}
