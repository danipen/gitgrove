import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/ipc'
import type { GitAvailability, RepoOpenResult, UpdateStatus } from '@shared/types'
import { app, type BrowserWindow, nativeImage } from 'electron'
import { APP_USER_MODEL_ID, REPO_URL } from './app-info'
import { refreshAppShortcuts } from './app-shortcuts'
import { hasNewWindowFlag, resolveStartupRepo } from './cli'
import { gitVersion, locateGit, resetGitLocation } from './git/bin'
import {
  addSafeDirectory,
  DubiousOwnershipError,
  getQuickSummary,
  getRemoteCloneUrl,
  resolveRepoRoot
} from './git/read'
import { registerIpc } from './ipc'
import { buildMenu, type MenuContext } from './menu'
import { loadSession, saveSession } from './session-store'
import { getRecentRepo, rememberRepo, setRecentsChangedListener } from './store'
import { checkForUpdates, initAutoUpdater } from './updater'
import { RepoWatcher } from './watcher'
import { WindowManager } from './windows'

const isDev = !app.isPackaged

// A dev run (`bun run dev`) and an installed release share GitGrove's identity,
// so they'd land on the same userData dir — and thus the same single-instance
// lock below (Chromium keeps that lock file inside userData). That made the two
// mutually exclusive: launching dev while the release was open (or vice versa)
// just routed argv into the running instance and quit silently. Give the dev
// build its own userData dir so its lock and state stand alone: release + dev
// now run side by side, and dev never clobbers your real recents/session.
// Must run before requestSingleInstanceLock and before app 'ready'.
if (isDev) {
  app.setPath('userData', `${app.getPath('userData')} (dev)`)
}

// One process, many windows. A second launch (double-clicking the app again,
// `gitgrove --repo <path>` from a shell) must join the running instance: two
// processes would race each other on the recents store, the window-state file
// and the accounts cipher. The running instance reacts in 'second-instance'
// below — it opens the requested repo in a new window, or just raises a window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// Chromium's OSCrypt encrypts its own on-disk data (cookies, storage) with a
// key it keeps in the OS secret store — the macOS keychain entry "GitGrove
// Safe Storage". Reaching that entry pops a "GitGrove wants to use your
// confidential information" password dialog, because our ad-hoc-signed builds
// get a fresh code signature each version, so the keychain ACL never matches
// the new signature and the grant can't persist. GitGrove keeps no secrets
// (recents are plaintext JSON), so opt out of the OS store entirely and let
// Chromium use an in-memory key instead. Must run before app ready.
//
// Two flags are needed because they cover different platforms:
//   - `password-store=basic` selects Chromium's basic (in-memory) store on
//     *Linux* (libsecret/kwallet otherwise). It is a NO-OP on macOS — OSCrypt
//     there always uses the Keychain regardless of this switch, which is why
//     the dialog kept appearing despite it.
//   - `use-mock-keychain` is the macOS lever: it makes OSCrypt use a mock,
//     in-process keychain and never touch the real one (verified: with it set,
//     the "GitGrove Safe Storage" entry is no longer created or read).
app.commandLine.appendSwitch('password-store', 'basic')
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-mock-keychain')
}

// Windows: adopt the installer's AppUserModelID so the taskbar groups our
// windows under the installed shortcut — required for the Jump List
// (app-shortcuts.ts) to appear on the pinned/Start-menu icon.
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

// Opt-in CDP debugging: when GITGROVE_DEBUG_PORT is set (e.g. `bun dev:debug`),
// expose Chromium's remote-debugging endpoint so tools like the Playwright CLI
// can attach to the renderer (`playwright-cli attach --cdp http://localhost:PORT`).
// Never set in normal or packaged runs, so the port stays closed by default.
if (process.env.GITGROVE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.GITGROVE_DEBUG_PORT)
}

// A repository named on the command line (`--repo <path>`) or via
// GITGROVE_OPEN_REPO, opened once the renderer mounts. Read exactly once (the
// first window's renderer asks for it on startup) so a later reload returns to
// the welcome screen instead of reopening it. Windows created for a specific
// repo ("Open in New Window", second-instance `--repo`) carry their own
// pending repo inside the WindowManager instead.
let startupRepoPath = resolveStartupRepo(process.argv, process.env)

const watcher = new RepoWatcher((repoPath) => {
  // Every window gets the ping; each renderer refreshes only when the path
  // matches its own open repo (see useOsIntegration), so windows on other
  // repos — and the welcome screen — stay untouched.
  windows.broadcast(IPC.repoChanged, repoPath)
})

// True from the moment the app starts quitting. Quitting closes windows one
// by one; without this flag that cascade would whittle the persisted session
// down to nothing right before we want to restore it.
let quitting = false

const windows = new WindowManager({
  onOpenReposChanged: (openRepos) => watcher.sync(openRepos),
  onMenuTargetChanged: () => rebuildMenuIfTargetChanged(),
  onSessionChanged: (session) => {
    // The empty snapshot is never saved: the last window's close is how the
    // app ends (it *is* the quit on Windows/Linux), so the state just before
    // it — that window and its repo — is exactly what the next launch should
    // bring back. Windows closed while others remain drop out as expected.
    if (!quitting && session.length > 0) saveSession(session)
  }
})

// The menu's only window-dependent state is the focused window's repo (its
// Repository actions capture the path at build time). Focus changes fire on
// every app switch, so rebuild only when that repo actually differs.
let menuRepoPath: string | null | undefined // undefined = menu never built
function rebuildMenuIfTargetChanged(): void {
  const repoPath = windows.repoOfFocusedWindow()
  if (repoPath === menuRepoPath) return
  menuRepoPath = repoPath
  buildMenu(menuContext)
}

// Update pushes go to every window: the "restart to update" banner is
// app-wide state, and whichever window the user answers from wins.
const pushUpdateStatus = (status: UpdateStatus) => windows.broadcast(IPC.updateStatus, status)

const menuContext: MenuContext = {
  getWindow: () => windows.focusedWindow(),
  getRepoPath: () => windows.repoOfFocusedWindow(),
  newWindow: () => windows.createWindow(),
  checkForUpdates: () => void checkForUpdates(pushUpdateStatus, true)
}

/**
 * Bring `path` to the front the least surprising way: focus the window that
 * already shows it, else reuse a window idling on the welcome screen, else
 * open a fresh window. Used by the launcher shortcuts (dock menu, Jump List
 * via second-instance) — never steals a window that has another repo open.
 */
function focusOrOpenRepo(path: string): void {
  const raise = (win: Electron.BrowserWindow) => {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  const showing = windows.windowShowing(path)
  if (showing) {
    raise(showing)
    return
  }
  const idle = windows.welcomeWindow()
  if (idle) {
    raise(idle)
    idle.webContents.send(IPC.openRepoRequest, path)
    return
  }
  windows.createWindow(path)
}

/**
 * Open a folder, resolve it to a repo root, persist as recent, watch it, and
 * associate it with the window that asked (menu targeting + watcher set).
 * Returns a cheap summary (current branch only) so the renderer can switch
 * instantly; branches and status are fetched separately by the renderer.
 */
async function openRepoAtPath(rawPath: string, win: BrowserWindow | null): Promise<RepoOpenResult> {
  // The folder is gone (a recent whose directory was deleted/moved): hand the
  // renderer the recovery screen with the last-known name + clone URL, rather
  // than failing as "not a git repository". git can't be queried on a path
  // that no longer exists, so this answer comes from the recents store.
  if (!existsSync(rawPath)) {
    const known = getRecentRepo(rawPath)
    return {
      ok: false,
      reason: 'missing',
      path: rawPath,
      name: known?.name ?? basename(rawPath),
      remoteUrl: known?.remoteUrl ?? null
    }
  }
  // The setup screen normally prevents reaching here without git; locateGit is a
  // backstop that throws a clear GitNotFoundError if git really is missing.
  await locateGit()
  let root: string | null
  try {
    root = await resolveRepoRoot(rawPath)
  } catch (e) {
    // git won't open the repo until its ownership is trusted — let the renderer
    // prompt the user instead of failing as if it weren't a repo.
    if (e instanceof DubiousOwnershipError) return { ok: false, reason: 'untrusted', path: rawPath }
    throw e
  }
  if (!root) return { ok: false, reason: 'not-git', path: rawPath }
  const summary = await getQuickSummary(root)
  // Remember the origin URL so "Clone Again" still works if this folder later
  // vanishes — best-effort, never block opening on it.
  const remoteUrl = await getRemoteCloneUrl(root).catch(() => null)
  rememberRepo({ path: summary.path, name: summary.name, remoteUrl })
  // Feed the OS-managed recents (macOS): the Dock renders this list in the
  // icon's menu even while GitGrove is *closed*; a click comes back as an
  // 'open-file' event (handled below). The system owns pruning/ordering, so
  // "Remove from Recents" in-app intentionally doesn't reach into it.
  if (process.platform === 'darwin') app.addRecentDocument(summary.path)
  // Point the menu's repo actions and the watcher at the now-open repo.
  if (win && !win.isDestroyed()) windows.setOpenRepo(win, summary.path)
  return { ok: true, summary }
}

/**
 * Trust a folder git flagged as untrusted, then open it. Re-probes to recover
 * git's exact recommended `safe.directory` value, persists it globally (so the
 * trust sticks across sessions and tools), and opens. If the folder is already
 * trusted by the time we get here, this just opens it.
 */
async function trustRepo(rawPath: string, win: BrowserWindow | null): Promise<RepoOpenResult> {
  try {
    await resolveRepoRoot(rawPath)
  } catch (e) {
    if (e instanceof DubiousOwnershipError) {
      await addSafeDirectory(e.safeValue)
    } else {
      throw e
    }
  }
  return openRepoAtPath(rawPath, win)
}

/**
 * Report whether a usable git is available. `force` re-probes (used by the
 * setup screen's "Re-check" after the user installs git) instead of reusing the
 * cached lookup.
 */
async function checkGit(force: boolean): Promise<GitAvailability> {
  if (force) resetGitLocation()
  try {
    const path = await locateGit()
    const version = await gitVersion()
    return { available: true, path, version, platform: process.platform }
  } catch {
    return { available: false, platform: process.platform }
  }
}

// macOS hands us paths as 'open-file' Apple Events: a Dock-menu recent, a
// folder dragged onto the dock icon, or "Open With → GitGrove" in Finder.
// Before the app is ready the event beats window creation — stash the path as
// the startup repo for the first window; afterwards route it like any other
// launcher click. (Registered at top level: the event can fire pre-ready.)
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (app.isReady()) focusOrOpenRepo(path)
  else startupRepoPath = path
})

// A second launch routed its argv here (see requestSingleInstanceLock above).
// `--repo <path>` focuses or opens that repo (a Jump List recent, "open two
// GitGroves" on Windows/Linux, shell aliases); `--new-window` (the Jump List
// and Linux desktop-action task) opens a fresh window; a bare relaunch raises
// a window (or recreates one if all were closed, e.g. on macOS with the app
// still running).
app.on('second-instance', (_e, argv) => {
  const repoPath = resolveStartupRepo(argv, {})
  if (repoPath) {
    focusOrOpenRepo(repoPath)
    return
  }
  if (hasNewWindowFlag(argv) || windows.windowCount() === 0) {
    windows.createWindow()
    return
  }
  const win = windows.focusedWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: 'Copyright © 2026 GitGrove',
    website: REPO_URL
  })

  // macOS ignores the BrowserWindow icon and shows the bundle icon in the
  // dock; in dev that's the generic Electron icon, so override it explicitly.
  if (isDev && process.platform === 'darwin' && app.dock) {
    // build/icon.png sits two levels up from out/main (ESM: no __dirname).
    const devIconPath = join(dirname(fileURLToPath(import.meta.url)), '../../build/icon.png')
    const img = nativeImage.createFromPath(devIconPath)
    if (!img.isEmpty()) app.dock.setIcon(img)
  }

  // Launcher shortcuts (dock menu / Jump List), rebuilt whenever the recents
  // store changes. macOS recents ride the OS list instead — see app-shortcuts.
  const shortcutActions = { newWindow: () => void windows.createWindow() }
  refreshAppShortcuts(shortcutActions)
  setRecentsChangedListener(() => refreshAppShortcuts(shortcutActions))

  registerIpc({
    windowFrom: (sender) => windows.windowFrom(sender),
    focusedWindow: () => windows.focusedWindow(),
    broadcast: (channel, ...args) => windows.broadcast(channel, ...args),
    openRepoAtPath,
    openRepoInNewWindow: (path) => void windows.createWindow(path),
    // The CLI repo belongs to the first window; windows created for a repo
    // ("Open in New Window") consume their own pending path instead.
    takeInitialRepoPath: (win) => {
      const pending = win ? windows.takePendingRepo(win) : null
      if (pending) return pending
      const path = startupRepoPath
      startupRepoPath = null
      return path
    },
    trustRepo,
    checkGit,
    checkForUpdates: (manual) => checkForUpdates(pushUpdateStatus, manual)
  })
  rebuildMenuIfTargetChanged()

  // Restore last session's windows — every window with the repo it had open —
  // unless a specific repo was requested (CLI `--repo`, a Dock recent while
  // closed): an explicit ask opens exactly that, nothing else. Repos whose
  // folder vanished since come back as the recovery screen, welcome-screen
  // windows (null) as themselves; an empty/missing session is a fresh start.
  const session = startupRepoPath !== null ? [] : loadSession()
  if (session.length === 0) {
    windows.createWindow()
  } else {
    for (const repoPath of session) windows.createWindow(repoPath ?? undefined)
  }

  initAutoUpdater(pushUpdateStatus)

  app.on('activate', () => {
    if (windows.windowCount() === 0) windows.createWindow()
  })
})

app.on('window-all-closed', () => {
  watcher.unwatchAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  watcher.unwatchAll()
})
