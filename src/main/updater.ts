// Auto-update wiring built on electron-updater (GitHub Releases provider, see
// electron-builder.yml). The main process owns the autoUpdater instance and
// relays its lifecycle to the renderer as `UpdateStatus` pushes; the renderer
// only ever asks to "check" or "install".
//
// Behaviour:
//  - On launch we run one silent background check (errors stay quiet), then a
//    silent re-check every hour so long-running sessions still notice releases.
//  - The Help ▸ "Check for Updates…" menu item and the About dialog run a
//    *manual* check, which also surfaces the "you're up to date" result.
//  - Updates download automatically; when ready the renderer shows a banner
//    offering to restart. Quitting also installs a pending update.
//
// macOS without a Developer ID signature:
//  electron-updater installs via the native Squirrel.Mac (ShipIt), which always
//  validates the downloaded app's code signature against the running app's
//  requirement. Unsigned / ad-hoc builds fail this ("code failed to satisfy
//  specified code requirement(s)"). For those we skip Squirrel entirely:
//  detection still works, we download the .dmg ourselves with progress, and let
//  the user finish the install by opening it (drag to Applications).

import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import { IPC } from '@shared/ipc'
import type { UpdateStatus } from '@shared/types'
import { app, type BrowserWindow, shell } from 'electron'
import electronUpdater, { type UpdateInfo } from 'electron-updater'

import { REPO_URL } from './app-info'
import { describeUpdateError } from './update-error'

// electron-updater is CommonJS; under our ESM main bundle the instance lives on
// the default export.
const { autoUpdater } = electronUpdater

const execFileAsync = promisify(execFile)

// Delay before the first launch check, so we don't compete with first paint.
const INITIAL_CHECK_DELAY_MS = 4000
// How often to silently re-check while the app stays open. Hourly is frequent
// enough to catch same-day releases without hammering GitHub on idle sessions.
const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000

const version = app.getVersion()
let manualCheck = false
let initialized = false
// True on macOS when the running build lacks a Developer ID signature, so the
// native Squirrel.Mac install would fail and we fall back to manual install.
let manualMode = false
// Absolute path of a .dmg we've downloaded and are waiting for the user to open.
let pendingInstallFile: string | null = null

/** Push an UpdateStatus to the renderer, stamped with version + manual flag. */
function pushStatus(
  getWindow: () => BrowserWindow | null,
  status: Omit<UpdateStatus, 'version' | 'manual'>
): void {
  getWindow()?.webContents.send(IPC.updateStatus, {
    ...status,
    version,
    manual: manualCheck
  } satisfies UpdateStatus)
}

/** Flatten electron-updater's string | {note}[] release notes to plain text. */
function notesToText(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes.replace(/<[^>]+>/g, '').trim() || undefined
  return (
    notes
      .map((n) => n.note ?? '')
      .join('\n\n')
      .replace(/<[^>]+>/g, '')
      .trim() || undefined
  )
}

/**
 * Decide whether macOS auto-install would fail for lack of a Developer ID
 * signature. We ask `codesign` about the running .app bundle: a real Developer
 * ID signature is what Squirrel.Mac needs, so its absence (ad-hoc, or no
 * signature at all — codesign then exits non-zero) means we use manual install.
 * Returns false on every non-macOS / unpackaged build (native flow is fine).
 */
async function detectManualMode(): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  try {
    // process.execPath → …/GitGrove.app/Contents/MacOS/GitGrove; the bundle is
    // three levels up.
    const bundle = path.resolve(process.execPath, '..', '..', '..')
    const { stdout, stderr } = await execFileAsync('codesign', ['-dv', '--verbose=4', bundle])
    return !/Authority=Developer ID Application/.test(`${stdout}${stderr}`)
  } catch {
    // codesign failed (typically "code object is not signed at all").
    return true
  }
}

/** Stream a URL to `dest`, reporting integer percent + bytes/sec as it goes. */
async function downloadFile(
  url: string,
  dest: string,
  onProgress: (percent: number, bytesPerSecond: number) => void
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'GitGrove' } })
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || 0
  const started = Date.now()
  let received = 0
  const body = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    const elapsed = (Date.now() - started) / 1000 || 1
    onProgress(total ? Math.round((received / total) * 100) : 0, received / elapsed)
  })
  await pipeline(body, createWriteStream(dest))
}

/**
 * Manual-install path: download the release .dmg ourselves (with progress) and
 * leave it ready for the user to open. The .dmg shares electron-builder's
 * artifact name with the .zip electron-updater advertised, so we swap the
 * extension to find it under the same release tag.
 */
async function downloadForManualInstall(
  info: UpdateInfo,
  getWindow: () => BrowserWindow | null
): Promise<void> {
  const push = pushStatus.bind(null, getWindow)

  try {
    // latest-mac.yml lists every arch's artifacts and the update-available
    // event hands us that whole list unfiltered — electron-updater only narrows
    // it by arch inside the Squirrel download path we bypass here, so files[0]
    // is just whatever built first (x64). Picking it blindly would hand Apple
    // Silicon users the Intel build, which then runs the entire app under
    // Rosetta (slow). Select the artifact matching the host arch instead. Our
    // names carry an explicit token (…-macOS-arm64.* / …-macOS-x64.*), and
    // runningUnderARM64Translation lets an x64 build already stuck under Rosetta
    // self-heal to native arm64 on its next update.
    const hostArch = app.runningUnderARM64Translation ? 'arm64' : process.arch
    const zipName =
      info.files?.find((f) => f.url.includes(`-macOS-${hostArch}.zip`))?.url ??
      info.files?.[0]?.url ??
      `GitGrove-${info.version}-macOS-${hostArch}.zip`
    const dmgName = zipName.replace(/\.zip$/i, '.dmg')
    const dest = path.join(app.getPath('downloads'), dmgName)
    const notes = notesToText(info.releaseNotes)

    // Don't re-download something we already fetched this session.
    if (pendingInstallFile !== dest) {
      const url = `${REPO_URL}/releases/download/v${info.version}/${dmgName}`
      push({ state: 'downloading', newVersion: info.version, percent: 0 })
      let lastPercent = -1
      await downloadFile(url, dest, (percent, bytesPerSecond) => {
        if (percent !== lastPercent) {
          lastPercent = percent
          push({ state: 'downloading', newVersion: info.version, percent, bytesPerSecond })
        }
      })
      pendingInstallFile = dest
    }

    push({ state: 'manual-install', newVersion: info.version, notes, downloadedFile: dest })
  } catch (err) {
    push({ state: 'error', error: describeUpdateError(err) })
  }
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const push = pushStatus.bind(null, getWindow)

  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    // Unsigned macOS: take over the download so Squirrel never tries (and fails)
    // to validate. Everywhere else electron-updater downloads automatically.
    if (manualMode) {
      void downloadForManualInstall(info, getWindow)
    } else {
      push({ state: 'available', newVersion: info.version, notes: notesToText(info.releaseNotes) })
    }
  })
  autoUpdater.on('update-not-available', () => push({ state: 'not-available' }))
  autoUpdater.on('download-progress', (p) =>
    push({ state: 'downloading', percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond })
  )
  autoUpdater.on('update-downloaded', (info) =>
    push({ state: 'downloaded', newVersion: info.version, notes: notesToText(info.releaseNotes) })
  )
  autoUpdater.on('error', (err) => push({ state: 'error', error: describeUpdateError(err) }))

  // Detect signing first, then configure Squirrel and run one quiet check
  // shortly after startup so we don't compete with first paint.
  void detectManualMode().then((manual) => {
    manualMode = manual
    if (manual) {
      // Never let Squirrel.Mac attempt the install it can't validate.
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
    }
    setTimeout(() => {
      void checkForUpdates(getWindow, false)
      // Keep checking while the app is open; unref so a pending timer never
      // holds the process alive past quit.
      setInterval(() => void checkForUpdates(getWindow, false), PERIODIC_CHECK_INTERVAL_MS).unref()
    }, INITIAL_CHECK_DELAY_MS)
  })
}

export async function checkForUpdates(
  getWindow: () => BrowserWindow | null,
  manual: boolean
): Promise<void> {
  manualCheck = manual

  // electron-updater throws ("update checking is disabled…") for unpackaged
  // builds. Tell the user plainly when they ask; stay silent on auto-checks.
  if (!app.isPackaged) {
    if (manual) {
      getWindow()?.webContents.send(IPC.updateStatus, {
        state: 'dev',
        version,
        manual: true
      } satisfies UpdateStatus)
    }
    return
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    getWindow()?.webContents.send(IPC.updateStatus, {
      state: 'error',
      version,
      manual,
      error: describeUpdateError(err)
    } satisfies UpdateStatus)
  }
}

export async function quitAndInstall(): Promise<void> {
  // Manual-install fallback: open the downloaded .dmg (Finder mounts it and
  // shows the drag-to-Applications window) and quit so the user can replace the
  // running app.
  if (pendingInstallFile) {
    await shell.openPath(pendingInstallFile)
    app.quit()
    return
  }
  // isSilent=true (run the NSIS installer silently — no UI; per-user install, so
  // no UAC prompt), isForceRunAfter=true (relaunch). Gives a near-instant
  // restart-to-update on Windows; macOS (Squirrel.Mac) is unaffected.
  autoUpdater.quitAndInstall(true, true)
}
