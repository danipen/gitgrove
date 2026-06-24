// Ensures Electron's binary is installed after `bun install` — the single place
// both a fresh-clone install (via package.json "postinstall") and CI rely on.
//
// Electron >= 42 no longer fetches its prebuilt binary in its own postinstall
// (GitHub Desktop does the same eager fetch in script/post-install.ts), so we
// run electron/install.js on demand. It's idempotent: an already-extracted
// binary is an instant no-op, so a warm machine / repeat install costs nothing.
//
// We check the installed binary by its files (path.txt + dist), NOT via
// `require('electron')` — requiring it has a side effect (electron/index.js
// auto-spawns install.js and prints "Downloading Electron binary..."), which
// muddies the logs and double-installs. And success means the binary is
// *present on disk*, NOT that it launches: the lint/unit jobs (and headless
// Linux) can't run `electron --version`, and don't need to — launching is the
// E2E smoke's job.
//
// By default this is best-effort: if the binary can't be installed (a flaky
// download, or a platform with no prebuilt — e.g. win32-arm64), it warns and
// exits 0 so `bun install` still succeeds for anyone who only lints/tests. Pass
// `--require` (the E2E job does) to fail hard when the binary is missing.
//
// macOS twist: a freshly extracted Electron.app is rejected by Gatekeeper
// ("Killed: 9") until its quarantine attribute is cleared and it's ad-hoc
// re-signed. GitHub Desktop never hits this because it never launches Electron
// in CI; our E2E smoke does, so we fix it up here (best-effort) — which also
// gives local macOS dev a launchable binary from a plain `bun install`.
//
// extract-zip twist: on the macos-26 GitHub runner, electron/install.js's
// extractor (extract-zip) *silently reports success while unpacking nothing* —
// no error, no files, no path.txt. @electron/get still downloads and
// checksum-validates the release zip into its cache reliably (that step is
// never the failure), so when install.js leaves dist/ empty we unpack that same
// cached zip ourselves with the OS-native tool. See extractCachedZip below.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

// Best-effort by default; `--require` (the E2E job) fails hard on a missing binary.
const required = process.argv.includes('--require')

/** node_modules/electron — resolved without running electron/index.js. */
const electronDir = dirname(require.resolve('electron/package.json'))

/**
 * Absolute path to the extracted Electron executable, or null when it isn't
 * installed. Reads electron's own path.txt (written by install.js) — no
 * `require('electron')`, so it has no download side effect.
 */
function binaryPath() {
  const pathFile = join(electronDir, 'path.txt')
  if (!existsSync(pathFile)) return null
  const rel = readFileSync(pathFile, 'utf8').trim()
  if (!rel) return null
  const bin = join(electronDir, 'dist', rel)
  return existsSync(bin) ? bin : null
}

/**
 * macOS only: clear the quarantine xattr and ad-hoc re-sign the extracted app
 * so Gatekeeper doesn't kill it on launch ("Killed: 9"). Best-effort and
 * idempotent. No-op off macOS or before the app exists.
 */
function macosFixup() {
  if (process.platform !== 'darwin') return
  const bin = binaryPath()
  if (!bin) return
  const i = bin.indexOf('.app')
  if (i === -1) return
  const app = bin.slice(0, i + 4) // …/Electron.app/Contents/MacOS/Electron → …/Electron.app
  spawnSync('xattr', ['-cr', app], { stdio: 'ignore' })
  spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
}

/** @electron/get's on-disk download caches (only the current OS's path exists). */
const cacheDirs = [
  join(homedir(), '.cache', 'electron'),
  join(homedir(), 'Library', 'Caches', 'electron'),
  join(homedir(), 'AppData', 'Local', 'electron', 'Cache')
]

/** Synchronous backoff — postinstall is synchronous, so keep the retry simple. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** electron's pinned version (e.g. "42.3.2") — names the cached release zip. */
const { version: electronVersion } = require(join(electronDir, 'package.json'))

/**
 * Relative path of the executable inside dist/ — the exact string electron's
 * own install.js writes to path.txt (forward slashes, even on Windows).
 */
function relativeExePath() {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'win32':
      return 'electron.exe'
    default:
      return 'electron'
  }
}

/**
 * The validated release zip @electron/get downloaded, located in its on-disk
 * cache (laid out as <cacheDir>/<sha256>/electron-v<ver>-<plat>-<arch>.zip), or
 * null if it isn't there.
 */
function cachedZipPath() {
  const name = `electron-v${electronVersion}-${process.platform}-${process.arch}.zip`
  for (const root of cacheDirs) {
    if (!existsSync(root)) continue
    for (const sub of readdirSync(root)) {
      const zip = join(root, sub, name)
      if (existsSync(zip)) return zip
    }
  }
  return null
}

/**
 * Fallback for when install.js's extract-zip silently unpacks nothing (the
 * macos-26 runner): unpack the cached, already-validated zip into dist/ with
 * the OS-native tool and write path.txt. `ditto` preserves the macOS .app
 * bundle's symlinks and permissions; `tar` reads zips on Windows 10+; `unzip`
 * elsewhere. No-op when the zip isn't cached or extraction fails — install.js's
 * own result then stands and the caller's retry/best-effort logic takes over.
 */
function extractCachedZip() {
  const zip = cachedZipPath()
  if (!zip) return
  const dist = join(electronDir, 'dist')
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['ditto', ['-x', '-k', zip, dist]]
      : process.platform === 'win32'
        ? ['tar', ['-xf', zip, '-C', dist]]
        : ['unzip', ['-q', '-o', zip, '-d', dist]]
  console.log(`Extracting Electron with ${cmd} (install.js left dist/ empty)…`)
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    console.warn(`Native extraction with ${cmd} failed; keeping install.js's result.`)
    return
  }
  writeFileSync(join(electronDir, 'path.txt'), relativeExePath())
}

/**
 * Run electron/install.js directly. `freshDownload` forces a genuine
 * re-download: `force_no_cache` alone is not honored by @electron/get here, so
 * we also delete its on-disk cache — otherwise a poisoned/partial zip is
 * re-extracted forever. DEBUG is always on so a failed download prints its
 * cause (it only runs when there's actually something to install).
 */
function reinstall(freshDownload) {
  rmSync(join(electronDir, 'dist'), { recursive: true, force: true })
  rmSync(join(electronDir, 'path.txt'), { force: true })
  const env = { ...process.env, DEBUG: '@electron/get:*' }
  if (freshDownload) {
    env.force_no_cache = 'true'
    env.electron_use_remote_checksums = '1'
    for (const dir of cacheDirs) rmSync(dir, { recursive: true, force: true })
  }
  const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    stdio: 'inherit',
    env
  })
  if (result.error) console.warn(`install.js could not run: ${result.error.message}`)
  else if (result.status !== 0) console.warn(`install.js exited with status ${result.status}`)
  // extract-zip can report success while unpacking nothing (macos-26 runner);
  // the download still cached a validated zip, so extract it ourselves.
  if (!binaryPath()) extractCachedZip()
}

// Already extracted (warm machine / repeat install): just keep it launchable.
if (binaryPath()) {
  macosFixup()
  process.exit(0)
}

for (let attempt = 1; attempt <= 4; attempt++) {
  console.log(`Installing the Electron binary (attempt ${attempt}/4)…`)
  reinstall(attempt >= 2) // attempt 1 trusts the cache; later ones force a fresh download
  if (binaryPath()) {
    macosFixup()
    process.exit(0)
  }
  sleep(attempt * 3000) // 3s, 6s, 9s — ride out a transient GitHub-releases blip
}

const detail = `${process.platform} ${process.arch}`
if (required) {
  console.error(`\nElectron binary could not be installed after 4 attempts (${detail}).`)
  process.exit(1)
}
// Best-effort: don't break `bun install` for lint/test-only use or a platform
// without a prebuilt binary. The app just won't launch until it's installed.
console.warn(
  `\nElectron binary not installed (${detail}); continuing — it's only needed to run the app.`
)
process.exit(0)
