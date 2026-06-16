// Settings → Appearance: the theme preference (system / light / dark). The
// same control the toolbar offers, centralized here so settings is the one
// place to look for "how do I change…".

import { Icon } from '@/lib/icons'
import { THEME_OPTIONS, type ThemePref } from '@/lib/theme'

interface Props {
  pref: ThemePref
  onChange: (pref: ThemePref) => void
}

export function AppearancePane({ pref, onChange }: Props) {
  return (
    <div className="acct-flow" role="radiogroup" aria-label="Theme">
      {THEME_OPTIONS.map((option) => {
        const OptIcon = Icon[option.icon]
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={pref === option.value}
            className={`acct-choice${pref === option.value ? ' is-selected' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <OptIcon size={18} />
            <span className="acct-choice__main">
              <span className="acct-choice__title">{option.label}</span>
              <span className="acct-choice__sub">{option.sub}</span>
            </span>
            {pref === option.value && <Icon.Check size={14} />}
          </button>
        )
      })}
    </div>
  )
}
