import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { lfsBinaryLocations, resetGitLfsLocation, resetGitLocation } from './bin'
import { getRepoSnapshot } from './status'

// The snapshot's `git status` spawns the LFS filter helper for racily-stat'd
// files; a GUI app's login PATH omits Homebrew's bin, so `git-lfs` is invisible
// and status dies with "git-lfs: command not found". getRepoSnapshot must
// resolve git-lfs (prepending its dir to PATH) before running git. We prove
// that deterministically — no dependence on git's racy heuristic actually
// firing — by reproducing the gap: a PATH where `git` resolves but `git-lfs`
// does not, while git-lfs still exists at its real (probed) location off PATH.
//
// Preconditions for a faithful repro (else the test skips, never fails
// spuriously): POSIX (the gap is built from a `git` symlink + /bin/sh), and a
// git-lfs install sitting in a directory the resolver probes — so it can be
// re-found once stripped from PATH.

/** Absolute path of a binary on the current PATH, via POSIX `command -v`. */
function whichBin(name: string): string | null {
  try {
    const out = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
    return out.trim() || null
  } catch {
    return null
  }
}

const gitPath = process.platform === 'win32' ? null : whichBin('git')
const gitLfsPath = process.platform === 'win32' ? null : whichBin('git-lfs')
// The directory git-lfs lives in — only meaningful when the resolver also
// probes it; both are asserted by `canRepro`, so the test body treats them as
// present.
const lfsDir = gitLfsPath ? dirname(gitLfsPath) : ''
const lfsIsProbed = lfsDir !== '' && lfsBinaryLocations().map(dirname).includes(lfsDir)
const canRepro = gitPath != null && lfsIsProbed

let configHome: string

beforeAll(() => {
  // Hermetic git config so the host's globals can't perturb the snapshot.
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-lfs-config-'))
  const emptyConfig = join(configHome, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig
})

afterAll(() => {
  rmSync(configHome, { recursive: true, force: true })
  delete process.env.GIT_CONFIG_GLOBAL
  delete process.env.GIT_CONFIG_SYSTEM
})

describe('getRepoSnapshot LFS PATH bridging', () => {
  test.skipIf(!canRepro)('puts git-lfs on PATH before running git status', async () => {
    const savedPath = process.env.PATH
    const repo = mkdtempSync(join(tmpdir(), 'gitgrove-lfs-snap-'))
    const shimDir = mkdtempSync(join(tmpdir(), 'gitgrove-git-shim-'))
    const git = (...args: string[]) =>
      execFileSync(gitPath as string, args, { cwd: repo, encoding: 'utf8' })
    try {
      // A one-commit repo — the snapshot only needs a runnable `git status`.
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'README.md'), '# hi\n')
      git('add', '.')
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'init'
      )

      // The GUI login-PATH gap: `git` resolves (via the shim) but `git-lfs`
      // does not — yet git-lfs still lives at its real, probed location off PATH.
      symlinkSync(gitPath as string, join(shimDir, 'git'))
      resetGitLocation()
      resetGitLfsLocation()
      process.env.PATH = shimDir
      expect(process.env.PATH.split(delimiter)).not.toContain(lfsDir)

      await getRepoSnapshot(repo)

      // The snapshot resolved git-lfs and prepended its dir, so a subsequent
      // `git status` could spawn the LFS filter. Without the fix, PATH would
      // still be just the shim dir.
      expect(process.env.PATH?.split(delimiter)).toContain(lfsDir)
    } finally {
      process.env.PATH = savedPath
      resetGitLocation()
      resetGitLfsLocation()
      rmSync(repo, { recursive: true, force: true })
      rmSync(shimDir, { recursive: true, force: true })
    }
  })
})
