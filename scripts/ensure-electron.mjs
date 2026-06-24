// Ensures Electron's binary is installed after `bun install` — the single place
// both a fresh-clone install (via package.json "postinstall") and CI rely on.
//
// Electron >= 42 no longer fetches its prebuilt binary in its own postinstall
// (GitHub Desktop does the same eager fetch in script/post-install.ts), so we
// run electron/install.js on demand. It's idempotent: an already-extracted
// binary is an instant no-op, so a warm machine / repeat install costs nothing.
//
// Success here means the binary is *present on disk*, NOT that it launches — the
// lint and unit-test jobs (and headless Linux generally) can't run `electron
// --version` without a display/libs, and they don't need to. Whether it
// actually launches is the E2E smoke's job.
//
// macOS twist: a freshly extracted Electron.app is rejected by Gatekeeper
// ("Killed: 9") until its quarantine attribute is cleared and it's ad-hoc
// re-signed. GitHub Desktop never hits this because it never launches Electron
// in CI; our E2E smoke does, so we fix it up here (best-effort) — which also
// gives local macOS dev a launchable binary from a plain `bun install`.

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** Absolute path to the Electron executable, or null when it isn't installed. */
function electronBinary() {
  try {
    // electron/index.js exports the binary path it read from path.txt; it
    // throws when the binary hasn't been fetched yet.
    return require('electron')
  } catch {
    return null
  }
}

/** True when the binary has been extracted to disk (existence, not launch). */
function installed() {
  const bin = electronBinary()
  return bin !== null && existsSync(bin)
}

/**
 * macOS only: clear the quarantine xattr and ad-hoc re-sign the extracted app
 * so Gatekeeper doesn't kill it on launch ("Killed: 9"). Best-effort and
 * idempotent. No-op off macOS or before the app exists.
 */
function macosFixup() {
  if (process.platform !== 'darwin') return
  const bin = electronBinary()
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

/**
 * Re-run electron/install.js. `freshDownload` forces a genuine re-download:
 * `force_no_cache` alone is not honored by @electron/get here, so we also delete
 * its on-disk cache — otherwise a poisoned/partial zip is re-extracted forever.
 */
function reinstall(freshDownload) {
  const electronDir = dirname(require.resolve('electron/package.json'))
  rmSync(join(electronDir, 'dist'), { recursive: true, force: true })
  rmSync(join(electronDir, 'path.txt'), { force: true })
  const env = { ...process.env }
  if (freshDownload) {
    env.force_no_cache = 'true'
    env.electron_use_remote_checksums = '1'
    for (const dir of cacheDirs) rmSync(dir, { recursive: true, force: true })
  }
  spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit', env })
}

// Already extracted (warm machine / repeat install): just keep it launchable.
if (installed()) {
  macosFixup()
  process.exit(0)
}

for (let attempt = 1; attempt <= 4; attempt++) {
  console.log(`Installing the Electron binary (attempt ${attempt}/4)…`)
  reinstall(attempt >= 2) // attempt 1 trusts the cache; later ones force a fresh download
  if (installed()) {
    macosFixup()
    process.exit(0)
  }
  sleep(attempt * 1000)
}

console.error('\nElectron binary could not be installed after 4 attempts.')
console.error(`  platform: ${process.platform} ${process.arch}`)
console.error(`  resolved path: ${electronBinary() ?? '(path.txt missing)'}`)
process.exit(1)
