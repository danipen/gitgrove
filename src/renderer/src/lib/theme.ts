// Theme handling. The user picks a *preference* (system / light / dark) which we
// persist; the *resolved* theme is what actually drives the UI ('light' | 'dark').
// 'system' tracks the OS color scheme live via matchMedia.
//
// The resolved theme is reflected onto <html data-theme="…">, which flips the CSS
// custom properties in styles/base.css. It's also passed to the diff viewer so it can
// pick the matching Shiki/pierre theme.

import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export function pierreThemeFor(theme: ResolvedTheme): 'pierre-light' | 'pierre-dark' {
  return theme === 'light' ? 'pierre-light' : 'pierre-dark'
}

// Pin pierre's editor surface to our app background. The pierre themes hardcode
// a near-black editor background (#0a0a0a) that reads far darker than the rest
// of the dark UI; pierre derives every diff tint (context, addition, deletion,
// separators, the empty-side hatch) from one variable — `--diffs-bg` — via
// color-mix. Re-seed just that variable, plus the host fill, with our own
// `--bg` (the same surface the commit fields and list filters sit on), and the
// whole palette re-mixes to match the UI while pierre's syntax tokens and git
// add/del colors (separate variables) stay exactly as the theme authored them.
//
// Fed through pierre's `unsafeCSS`, which lands in its last cascade layer
// (`@layer unsafe`), so it beats the theme's own `:host` background inside the
// shadow root. `--bg` inherits across the shadow boundary, so it tracks the
// active theme (light's #fff already equals our light --bg, so it's a no-op).
export const PIERRE_SURFACE_CSS = ':host{--diffs-bg:var(--bg);background-color:var(--bg)}'

/** A selectable theme: its label, one-line description and trigger glyph.
 *  Centralized so the toolbar switcher and Settings → Appearance show identical
 *  copy. `icon` is typed against the icons module without importing it, keeping
 *  this module (used on the pre-mount path) free of the UI dependency. */
export interface ThemeOption {
  value: ThemePref
  label: string
  sub: string
  icon: keyof typeof import('@/lib/icons')['Icon']
}

export const THEME_OPTIONS: ThemeOption[] = [
  { value: 'system', label: 'System', sub: 'Match the OS appearance', icon: 'Monitor' },
  { value: 'light', label: 'Light', sub: 'Bright surfaces', icon: 'Sun' },
  { value: 'dark', label: 'Dark', sub: 'Deep, calm dark UI', icon: 'Moon' }
]

const STORAGE_KEY = 'gg.theme'

export function readThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* ignore */
  }
  return 'system'
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref
}

/** Set <html data-theme> before React mounts so there's no flash of the wrong theme. */
export function applyInitialTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(readThemePref())
}

export function useTheme(): {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref: (pref: ThemePref) => void
} {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref)
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)

  // Keep the 'system' option live as the OS scheme changes.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = pref === 'system' ? system : pref

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  return { pref, resolved, setPref }
}
