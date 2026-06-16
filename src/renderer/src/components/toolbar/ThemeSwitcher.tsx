import { useRef, useState } from 'react'
import { Popover } from '@/components/common/Popover'
import { Icon } from '@/lib/icons'
import { type ResolvedTheme, THEME_OPTIONS, type ThemePref } from '@/lib/theme'

interface Props {
  pref: ThemePref
  resolved: ResolvedTheme
  onChange: (pref: ThemePref) => void
}

export function ThemeSwitcher({ pref, resolved, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)

  // The trigger glyph reflects what's actually showing, not the preference, so
  // 'System' surfaces a sun or moon depending on the resolved scheme.
  const TriggerIcon = resolved === 'light' ? Icon.Sun : Icon.Moon
  const currentLabel = THEME_OPTIONS.find((o) => o.value === pref)?.label ?? 'System'

  return (
    <>
      <button
        ref={anchor}
        className="toolbar__refresh"
        data-tip={`Theme: ${currentLabel} — click to change`}
        onClick={() => setOpen((v) => !v)}
      >
        <TriggerIcon size={16} />
      </button>

      <Popover
        anchor={anchor.current}
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        width={240}
      >
        <div className="popover__list">
          <div className="popover__group-label">Appearance</div>
          {THEME_OPTIONS.map((opt) => {
            const OptIcon = Icon[opt.icon]
            return (
              <button
                key={opt.value}
                className={`popover__item${pref === opt.value ? ' is-active' : ''}`}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
              >
                <span className="icon-muted">
                  <OptIcon size={15} />
                </span>
                <span className="popover__item-main">
                  <span className="popover__item-title">{opt.label}</span>
                  <span className="popover__item-sub">{opt.sub}</span>
                </span>
                {pref === opt.value && (
                  <span className="icon-muted" style={{ color: 'var(--accent)' }}>
                    <Icon.Check size={15} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </Popover>
    </>
  )
}
