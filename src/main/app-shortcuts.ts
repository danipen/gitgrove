// OS launcher shortcuts: recent repositories plus a "New Window" entry, one
// right-click away on the app's dock / taskbar icon — even before the app is
// focused (or, on macOS and via pinned Jump Lists, before it is *running*).
//
// Per-platform reality check:
//  - macOS: recents ride the OS-managed recent-documents list
//    (`app.addRecentDocument` in index.ts, stored per bundle id by the system)
//    — the Dock itself renders that section in the icon's menu whether or not
//    GitGrove is running, and clicks come back as 'open-file' events. Only the
//    "New Window" item needs the custom (running-only) dock menu here.
//  - Windows: Jump List items can only *launch a program*, so each entry
//    relaunches GitGrove with `--repo <path>` (or `--new-window`); the
//    single-instance lock routes that into the running instance, which opens
//    or focuses the repo (see 'second-instance' in index.ts). Rebuilt whenever
//    the recents change; the pinned icon keeps it while the app is closed.
//  - Linux: launchers only read static `[Desktop Action]`s from the .desktop
//    file — no runtime API — so it gets a packaged "New Window" action only
//    (electron-builder.yml) and nothing to do here.

import { app, Menu } from 'electron'
import { getRecentRepos } from './store'

// Windows renders Jump Lists as a tall dedicated flyout where ~8 entries is
// the platform's customary depth.
const JUMP_LIST_RECENTS = 8

/** What the shortcuts need from the app shell. */
export interface AppShortcutActions {
  /** Open a fresh window on the welcome screen. */
  newWindow(): void
}

/**
 * Rebuild the platform's launcher shortcuts from the current recents. Cheap
 * (one small template) and idempotent — safe to call on every recents write.
 */
export function refreshAppShortcuts(actions: AppShortcutActions): void {
  if (process.platform === 'darwin') {
    // Recents are the OS's section (see module comment) — adding them here too
    // would show every repo twice in the same menu.
    app.dock?.setMenu(
      Menu.buildFromTemplate([{ label: 'New Window', click: () => actions.newWindow() }])
    )
  }
  if (process.platform === 'win32') refreshJumpList()
}

function refreshJumpList(): void {
  // A Jump List entry launches `program` with `args` — in dev that program is
  // the generic Electron binary, which needs the app directory as its first
  // argument to become GitGrove.
  const devAppArg = app.isPackaged ? '' : `"${app.getAppPath()}" `
  const task = (args: string, title: string, description: string) =>
    ({
      type: 'task',
      program: process.execPath,
      args: `${devAppArg}${args}`,
      title,
      description,
      iconPath: process.execPath,
      iconIndex: 0
    }) as const

  // Folders that still exist, newest first — same filter as the repo switcher.
  const recents = getRecentRepos()
    .filter((repo) => !repo.missing)
    .slice(0, JUMP_LIST_RECENTS)

  // setJumpList can fail (e.g. items the OS rejects) — a launcher shortcut is
  // a convenience, never worth surfacing an error for, so ignore the outcome.
  app.setJumpList([
    {
      type: 'custom',
      name: 'Recent Repositories',
      items: recents.map((repo) => task(`--repo "${repo.path}"`, repo.name, repo.path))
    },
    {
      type: 'tasks',
      items: [task('--new-window', 'New Window', 'Open a new GitGrove window')]
    }
  ])
}
