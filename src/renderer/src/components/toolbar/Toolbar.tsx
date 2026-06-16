import type { BranchInfo, RepoSummary, SyncStatus } from '@shared/types'
import { useState } from 'react'
import { Icon } from '@/lib/icons'
import { isMac } from '@/lib/platform'
import type { ResolvedTheme, ThemePref } from '@/lib/theme'
import { type BranchAction, BranchSwitcher } from './BranchSwitcher'
import { MenuBar } from './MenuBar'
import { RepoSwitcher } from './RepoSwitcher'
import { type SyncAction, SyncButton } from './SyncButton'
import { ThemeSwitcher } from './ThemeSwitcher'
import { WindowControls } from './WindowControls'

interface Props {
  repo: RepoSummary | null
  branch: BranchInfo | null
  branchesLoading: boolean
  busy: boolean
  refreshing: boolean
  themePref: ThemePref
  resolvedTheme: ResolvedTheme
  sync?: SyncStatus | null
  syncRunning?: SyncAction | null
  /** Determinate 0–100 of the running sync action, or null before git reports any. */
  syncProgress?: number | null
  /** The checkout in flight: target branch + determinate progress. */
  switching?: { name: string; percent: number | null } | null
  onSyncAction?: (action: SyncAction) => void
  onBranchAction?: (action: BranchAction, branch: string) => void
  /** Lazy branch-list loader, called when the branch switcher opens. */
  onBranchesOpen?: () => void
  onOpenRepo: (path: string) => void
  onPickRepo: () => void
  onCheckout: (branch: string) => void
  onRefresh: () => void
  onThemeChange: (pref: ThemePref) => void
  onAbout: () => void
}

// Persist whether the (Windows/Linux) menu bar is expanded, mirroring how the
// theme preference is stored. Defaults to collapsed so the title bar stays tidy.
const MENU_KEY = 'gg.menuExpanded'
function readMenuExpanded(): boolean {
  try {
    return localStorage.getItem(MENU_KEY) === '1'
  } catch {
    return false
  }
}

export function Toolbar({
  repo,
  branch,
  branchesLoading,
  busy,
  refreshing,
  themePref,
  resolvedTheme,
  sync,
  syncRunning,
  syncProgress,
  switching,
  onSyncAction,
  onBranchAction,
  onBranchesOpen,
  onOpenRepo,
  onPickRepo,
  onCheckout,
  onRefresh,
  onThemeChange,
  onAbout
}: Props) {
  const [menuExpanded, setMenuExpanded] = useState(readMenuExpanded)

  const toggleMenu = () => {
    setMenuExpanded((prev) => {
      const next = !prev
      try {
        localStorage.setItem(MENU_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }

  return (
    <header className="toolbar">
      {/* leaves room for the macOS traffic lights in the draggable region */}
      {isMac && <div className="toolbar__drag-pad" />}
      {/* Windows/Linux: the native menu bar is hidden behind the custom title
          bar, so the brand doubles as its toggle — clicking it expands/collapses
          the menu (collapsed by default so the title bar isn't always crowded),
          with the chevron folded into the button as a single hover block. About
          lives in the Help menu there. macOS keeps its system menu, so the
          brand opens About instead and shows no chevron. */}
      <button
        className={`toolbar__brand${!isMac && menuExpanded ? ' is-expanded' : ''}`}
        title={isMac ? 'About GitGrove' : menuExpanded ? 'Hide menu' : 'Show menu'}
        aria-expanded={isMac ? undefined : menuExpanded}
        onClick={isMac ? onAbout : toggleMenu}
      >
        <Icon.Tree size={18} />
        GitGrove
        {!isMac && <Icon.Chevron size={16} className="toolbar__brand-chevron" />}
      </button>
      {!isMac && <MenuBar expanded={menuExpanded} />}
      <div className="toolbar__sep" />
      <RepoSwitcher repo={repo} onOpenRepo={onOpenRepo} onPickRepo={onPickRepo} />
      {repo && (
        <BranchSwitcher
          branch={branch}
          loading={branchesLoading}
          busy={busy}
          switching={switching}
          onCheckout={onCheckout}
          onBranchAction={onBranchAction}
          onOpen={onBranchesOpen}
        />
      )}
      {repo && onSyncAction && (
        <SyncButton
          sync={sync ?? null}
          branch={branch?.current ?? ''}
          detached={branch?.detached ?? false}
          busy={busy}
          running={syncRunning ?? null}
          progress={syncProgress}
          onAction={onSyncAction}
        />
      )}
      <div className="toolbar__spacer" />
      {repo && (
        <button
          className={`toolbar__refresh${refreshing ? ' is-spinning' : ''}`}
          data-tip="Refresh — re-read the working tree, status and history"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <Icon.Refresh size={16} />
        </button>
      )}
      <ThemeSwitcher pref={themePref} resolved={resolvedTheme} onChange={onThemeChange} />
      {/* Windows/Linux: the toolbar is the title bar, so it carries the caption
          buttons. macOS uses its native traffic lights instead. */}
      {!isMac && <WindowControls />}
    </header>
  )
}
