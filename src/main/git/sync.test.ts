import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pull } from './sync'

// Hermetic git: point global + system config at an empty file so the host's
// config (notably a machine-wide pull.rebase / pull.ff) can't mask the very
// case under test — a bare pull with no reconciliation strategy configured.
let configHome: string

beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-sync-config-'))
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

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function configureIdentity(dir: string): void {
  git(dir, 'config', 'user.name', 'Test User')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

function put(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content)
}

function commit(dir: string, name: string, content: string, message: string): void {
  put(dir, name, content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

/**
 * A clone whose local `main` has diverged from its upstream: one commit only
 * the remote has, one commit only the clone has. This is the exact state that
 * makes a bare `git pull` (no reconciliation strategy) abort since git 2.27.
 */
function divergedClone(): string {
  const bare = tmp('gitgrove-sync-remote-')
  git(bare, 'init', '-q', '--bare', '-b', 'main')

  // Seed the remote through a throwaway working clone.
  const seed = tmp('gitgrove-sync-seed-')
  git(seed, 'clone', '-q', bare, seed)
  configureIdentity(seed)
  commit(seed, 'README.md', 'seed\n', 'initial')
  git(seed, 'push', '-q', 'origin', 'main')

  // The clone under test, forked from the seed commit.
  const clone = tmp('gitgrove-sync-clone-')
  git(clone, 'clone', '-q', bare, clone)
  configureIdentity(clone)

  // Advance the remote by one commit (the clone is now "behind").
  commit(seed, 'remote.txt', 'from remote\n', 'remote change')
  git(seed, 'push', '-q', 'origin', 'main')

  // Advance the clone by a different commit (now "ahead" as well → diverged).
  commit(clone, 'local.txt', 'from local\n', 'local change')

  return clone
}

describe('pull', () => {
  test('reconciles a divergent branch with a merge instead of aborting', async () => {
    const clone = divergedClone()

    // The regression guard: a bare pull here used to fail with
    // "fatal: Need to specify how to reconcile divergent branches".
    await pull(clone)

    // Both histories survive: a merge brought the remote commit in while the
    // local commit stayed, and the merge itself is now HEAD.
    const log = git(clone, 'log', '--pretty=%s')
    expect(log).toContain('remote change')
    expect(log).toContain('local change')
    expect(git(clone, 'rev-list', '--count', '--merges', 'HEAD~1..HEAD').trim()).toBe('1')
  })

  test('respects an explicit pull.ff=only, leaving the divergence for the user', async () => {
    const clone = divergedClone()
    git(clone, 'config', 'pull.ff', 'only')

    // With their own strategy pinned we add nothing, so git's own ff-only rule
    // applies and refuses the non-fast-forward — their choice, not our default.
    await expect(pull(clone)).rejects.toThrow()
  })
})
