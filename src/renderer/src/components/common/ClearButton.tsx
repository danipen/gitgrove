// A small "×" that clears a filter input, shown only once it has text. Render
// it as the last child of the input's wrapper; positioning lives with each
// filter (see .input-clear in primitives.css). The mousedown is swallowed so a
// click never blurs the input — focus stays put and the user can keep typing.
// styles: primitives.css (.input-clear)

import { Icon } from '@/lib/icons'

interface Props {
  onClear: () => void
  /** Accessible label + tooltip (e.g. "Clear filter"). */
  label?: string
}

export function ClearButton({ onClear, label = 'Clear' }: Props) {
  return (
    <button
      type="button"
      className="input-clear"
      aria-label={label}
      data-tip={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClear}
    >
      <Icon.Close size={12} />
    </button>
  )
}
