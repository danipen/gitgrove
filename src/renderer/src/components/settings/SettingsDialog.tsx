// The Settings dialog (⌘,): one calm home for app-wide preferences —
// Accounts (connected git hosts), Identity (global commit author) and
// Appearance (theme). Works with or without a repository open; each section
// is its own pane component, so growing settings means adding a pane here
// and nothing else.

import { useState } from 'react'
import { DialogShell } from '@/components/common/Dialog'
import { Icon } from '@/lib/icons'
import type { ThemePref } from '@/lib/theme'
import { AccountsPane } from './AccountsPane'
import { AiPane } from './AiPane'
import { AppearancePane } from './AppearancePane'
import { IdentityPane } from './IdentityPane'

export type SettingsSection = 'accounts' | 'identity' | 'ai' | 'appearance'

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'identity', label: 'Identity' },
  { id: 'ai', label: 'AI' },
  { id: 'appearance', label: 'Appearance' }
]

interface Props {
  /** Open repository, if any — Identity uses it to surface local overrides. */
  repoPath?: string
  /** Section to open on — AI teasers deep-link straight to their setup. */
  initialSection?: SettingsSection
  themePref: ThemePref
  onThemePref: (pref: ThemePref) => void
  onClose: () => void
}

export function SettingsDialog({
  repoPath,
  initialSection,
  themePref,
  onThemePref,
  onClose
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'accounts')

  const sectionIcon = (id: SettingsSection) =>
    id === 'accounts' ? (
      <Icon.Github size={15} />
    ) : id === 'identity' ? (
      <Icon.Pencil size={15} />
    ) : id === 'ai' ? (
      <Icon.Sparkle size={15} />
    ) : (
      <Icon.Sun size={15} />
    )

  return (
    <DialogShell title="Settings" onClose={onClose} width={640}>
      <div className="settings">
        <nav className="settings__nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings__nav-item${section === s.id ? ' is-active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {sectionIcon(s.id)}
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings__pane">
          {section === 'accounts' && <AccountsPane />}
          {section === 'identity' && <IdentityPane repoPath={repoPath} />}
          {section === 'ai' && <AiPane />}
          {section === 'appearance' && <AppearancePane pref={themePref} onChange={onThemePref} />}
        </div>
      </div>
      <div className="trust__actions">
        <button className="btn-primary btn-primary--sm" onClick={onClose}>
          Done
        </button>
      </div>
    </DialogShell>
  )
}
