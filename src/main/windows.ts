// All BrowserWindow lifecycle in one place. GitGrove is multi-window: every
// window hosts one repository (or the welcome screen), all inside a *single*
// main process — so the per-repo write queue, the recents store and the
// window-state file keep exactly one writer, no matter how many windows are
// open. (index.ts enforces the single process with the single-instance lock.)
//
// The manager owns three pieces of per-window state:
//  - which repo each window has open (drives the application menu and the
//    watcher's ref-counted set of watched repos);
//  - the repo a freshly created window should open on boot ("Open in New
//    Window" / second-instance `--repo`), consumed once by initialRepoPath;
//  - which window was focused last, so menu actions and credential prompts
//    still have a sensible target while the app is in the background.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/ipc'
import { app, BrowserWindow, screen, shell, type WebContents } from 'electron'
import {
  cascadeBounds,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type Rect
} from './window-state'
import { loadWindowState, trackWindowState } from './window-state-store'

// The main bundle is emitted as ESM (package.json "type": "module"), where
// __dirname is not defined — reconstruct it from the module URL.
const moduleDir = dirname(fileURLToPath(import.meta.url))

// In a packaged build the app's icon comes from the .app/.exe bundle. While
// developing we run inside the generic Electron binary, so point the dock /
// window icon at build/icon.png (sits two levels up from out/main) ourselves.
const devIconPath = join(moduleDir, '../../build/icon.png')

const isDev = !app.isPackaged

/** What the app shell wires into the manager. */
export interface WindowManagerHooks {
  /** The set of repos open across all windows changed (open/close/reload). */
  onOpenReposChanged(openRepos: ReadonlySet<string>): void
  /** The window the application menu should target changed (focus/open/close). */
  onMenuTargetChanged(): void
}

export class WindowManager {
  private windows = new Set<BrowserWindow>()
  /** Repo open in each window, by window id. Absent → welcome screen. */
  private repoByWindow = new Map<number, string>()
  /** Repo a new window should open on boot, consumed once (see takePendingRepo). */
  private pendingRepoByWindow = new Map<number, string>()
  private lastFocused: BrowserWindow | null = null

  constructor(private hooks: WindowManagerHooks) {}

  /**
   * Create a window. The first window restores last session's geometry; every
   * additional one cascades down-right from the focused window so both stay
   * readable. `repoPath` (when given) is what the new window opens on boot —
   * its renderer picks it up through initialRepoPath.
   */
  createWindow(repoPath?: string): BrowserWindow {
    // Last session's geometry (already reconciled against the monitors attached
    // right now — see window-state.ts) applies to the first window only; later
    // windows cascade from the focused one and never open maximized, which
    // would bury the window they came from.
    const restored = this.windows.size === 0 ? loadWindowState() : null
    const win = new BrowserWindow({
      ...(restored
        ? (restored.bounds ?? { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT })
        : this.cascadeFromFocused()),
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      show: false,
      backgroundColor: '#0c0d10',
      // Window icon is used on Windows/Linux (ignored on macOS); only needed in
      // dev — packaged builds carry the icon in the executable.
      ...(isDev ? { icon: devIconPath } : {}),
      // macOS keeps its inset traffic lights. On Windows/Linux we hide the native
      // title bar and menu bar so the app's toolbar acts as the title bar, with
      // custom window controls (see WindowControls) painted into it — Alt still
      // reveals the menu bar on demand.
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 16, y: 18 },
      autoHideMenuBar: process.platform !== 'darwin',
      webPreferences: {
        preload: join(moduleDir, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.windows.add(win)
    // Captured now: BrowserWindow getters throw once the window is destroyed,
    // and the 'closed' cleanup below runs exactly then.
    const windowId = win.id
    if (repoPath) this.pendingRepoByWindow.set(windowId, repoPath)

    win.on('ready-to-show', () => {
      // Maximize/full-screen must wait until here: maximize() implicitly shows
      // the window, which before ready-to-show would flash an unpainted frame.
      if (restored?.isMaximized) win.maximize()
      if (restored?.isFullScreen) win.setFullScreen(true)
      win.show()
    })

    // Every window persists its geometry into the one state file; the last
    // write wins, so the next launch opens where the user last worked.
    trackWindowState(win)

    // Keep the renderer's custom window controls (Windows/Linux) in sync with
    // the real maximize state so the maximize/restore glyph matches the window.
    const emitMaximized = () => {
      if (!win.isDestroyed()) win.webContents.send(IPC.windowMaximized, win.isMaximized())
    }
    win.on('maximize', emitMaximized)
    win.on('unmaximize', emitMaximized)

    win.on('focus', () => {
      this.lastFocused = win
      // The application menu's Repository actions target the focused window's
      // repo — retarget them whenever focus moves between windows.
      this.hooks.onMenuTargetChanged()
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // A renderer reload (Ctrl/Cmd+R) drops back to the welcome screen with no
    // repo open, but the repo association survives here in the main process.
    // Clear it on every page load so the menu and the watcher don't keep
    // targeting the previously opened repo; setOpenRepo re-associates when the
    // user opens one again.
    win.webContents.on('did-start-loading', () => {
      if (this.repoByWindow.has(win.id)) this.setOpenRepo(win, null)
    })

    win.on('closed', () => {
      this.windows.delete(win)
      this.repoByWindow.delete(windowId)
      this.pendingRepoByWindow.delete(windowId)
      if (this.lastFocused === win) this.lastFocused = null
      this.hooks.onOpenReposChanged(this.openRepos())
      this.hooks.onMenuTargetChanged()
    })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      win.loadFile(join(moduleDir, '../renderer/index.html'))
    }

    return win
  }

  /** Bounds for an additional window: cascaded from the focused one. */
  private cascadeFromFocused(): Rect | { width: number; height: number } {
    const source = this.focusedWindow()
    if (!source) return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
    // getNormalBounds(): cascade from where the window *lives*, not the whole
    // screen it happens to be maximized over.
    const bounds = source.getNormalBounds()
    return cascadeBounds(bounds, screen.getDisplayMatching(bounds).workArea)
  }

  /**
   * The window the user is working in: the focused one, or — while the app is
   * in the background — the last one that had focus. Menu actions, credential
   * prompts and update dialogs aim here.
   */
  focusedWindow(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) return focused
    if (this.lastFocused && !this.lastFocused.isDestroyed()) return this.lastFocused
    return this.windows.values().next().value ?? null
  }

  /** The window hosting `sender`, or null when it's already gone. */
  windowFrom(sender: WebContents): BrowserWindow | null {
    return BrowserWindow.fromWebContents(sender)
  }

  /** Send to every open window; renderers filter by repo path where relevant. */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of this.windows) {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args)
    }
  }

  /** Record which repo `win` has open (null → welcome screen) and re-sync. */
  setOpenRepo(win: BrowserWindow, repoPath: string | null): void {
    if (repoPath === null) this.repoByWindow.delete(win.id)
    else this.repoByWindow.set(win.id, repoPath)
    this.hooks.onOpenReposChanged(this.openRepos())
    this.hooks.onMenuTargetChanged()
  }

  /** The repo the application menu should act on: the focused window's. */
  repoOfFocusedWindow(): string | null {
    const win = this.focusedWindow()
    return win ? (this.repoByWindow.get(win.id) ?? null) : null
  }

  /** The repo `win` was created to open, handed over exactly once. */
  takePendingRepo(win: BrowserWindow): string | null {
    const path = this.pendingRepoByWindow.get(win.id) ?? null
    this.pendingRepoByWindow.delete(win.id)
    return path
  }

  /** Every repo open in some window — the watcher's ref-counted watch set. */
  openRepos(): ReadonlySet<string> {
    return new Set(this.repoByWindow.values())
  }

  windowCount(): number {
    return this.windows.size
  }
}
