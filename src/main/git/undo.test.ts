import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRepoSnapshot } from './status'
import { readUndoSnapshot, relativeTime, undo } from './undo'
import { cherryPick, commitSelection, merge, rebase, reset, revertCommit } from './write'

// Hermetic git: point global + system config at an empty file so the host's
// config (notably Git for Windows' core.autocrlf=true) can't rewrite line
// endings or otherwise perturb these exact-content assertions.
let configHome: string

beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-undo-config-'))
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

const repos: string[] = []
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A fresh repo with a usable commit identity, tracked for cleanup. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitgrove-undo-'))
  repos.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test User')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function put(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content)
}

/** A repo with one seed commit, so there's always history to build on. */
function seedRepo(): string {
  const dir = initRepo()
  put(dir, 'README.md', 'seed')
  rawCommit(dir, 'initial')
  return dir
}

/** Commit everything via raw git (setup that records no undo point). */
function rawCommit(dir: string, message: string): string {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return head(dir)
}

function head(dir: string): string {
  return git(dir, 'rev-parse', 'HEAD').trim()
}

function status(dir: string): string {
  return git(dir, 'status', '--porcelain')
}

const COMMIT_ALL = { all: true, paths: [], patches: [] }

describe('relativeTime', () => {
  const base = Date.parse('2026-06-24T12:00:00Z')
  test('reads as "just now" within the first 45 seconds', () => {
    expect(relativeTime(new Date(base).toISOString(), base + 10_000)).toBe('just now')
  })
  test('rounds to whole minutes, hours and days with correct plurals', () => {
    expect(relativeTime(new Date(base).toISOString(), base + 60_000)).toBe('1 minute ago')
    expect(relativeTime(new Date(base).toISOString(), base + 5 * 60_000)).toBe('5 minutes ago')
    expect(relativeTime(new Date(base).toISOString(), base + 2 * 3_600_000)).toBe('2 hours ago')
    expect(relativeTime(new Date(base).toISOString(), base + 3 * 86_400_000)).toBe('3 days ago')
  })
  test('never goes negative for a clock skew into the future', () => {
    expect(relativeTime(new Date(base).toISOString(), base - 10_000)).toBe('just now')
  })
})

describe('undo commit', () => {
  test('reverts a commit, returns its message, and brings the change back', async () => {
    const dir = seedRepo() // c0
    const c0 = head(dir)
    put(dir, 'foo.txt', 'hello')
    await commitSelection(dir, 'add foo', COMMIT_ALL)
    expect(head(dir)).not.toBe(c0)

    const result = await undo(dir)
    expect(head(dir)).toBe(c0)
    expect(result.kind).toBe('commit')
    expect(result.message).toBe('add foo')
    // The committed file returns to the working tree (here as untracked, since
    // c0 never had it) — the change is not lost.
    expect(status(dir)).toContain('foo.txt')
    // The record is consumed (a subsequent undo would derive from git instead).
    expect(existsSync(join(dir, '.git', 'gitgrove', 'undo.json'))).toBe(false)
  })

  test('undoing the very first commit returns to an unborn branch', async () => {
    const dir = initRepo()
    put(dir, 'foo.txt', 'hello')
    await commitSelection(dir, 'first', COMMIT_ALL)
    expect(head(dir)).toMatch(/^[0-9a-f]{40}$/)

    const result = await undo(dir)
    expect(result.kind).toBe('commit')
    // No commits again — HEAD doesn't resolve — and the file is untracked.
    expect(() => head(dir)).toThrow()
    expect(status(dir)).toContain('?? foo.txt')
  })
})

describe('undo amend', () => {
  test('restores the pre-amend commit intact, with no message to restore', async () => {
    const dir = seedRepo()
    put(dir, 'a.txt', 'one')
    await commitSelection(dir, 'second', COMMIT_ALL)
    const original = head(dir)
    put(dir, 'b.txt', 'two')
    await commitSelection(dir, 'second amended', { ...COMMIT_ALL, amend: true })
    expect(head(dir)).not.toBe(original)

    const result = await undo(dir)
    expect(result.kind).toBe('amend')
    expect(result.message).toBeUndefined()
    expect(head(dir)).toBe(original)
  })
})

describe('undo merge', () => {
  /** main + feature diverged on different files, ready to merge cleanly. */
  function divergedRepo(): { dir: string; mainTip: string } {
    const dir = initRepo()
    put(dir, 'a.txt', 'base')
    rawCommit(dir, 'c0')
    git(dir, 'checkout', '-q', '-b', 'feature')
    put(dir, 'a.txt', 'feature')
    rawCommit(dir, 'feature change')
    git(dir, 'checkout', '-q', 'main')
    put(dir, 'm.txt', 'main')
    const mainTip = rawCommit(dir, 'main change')
    return { dir, mainTip }
  }

  test('restores the pre-merge tip after a clean merge', async () => {
    const { dir, mainTip } = divergedRepo()
    const outcome = await merge(dir, 'feature')
    expect(outcome).toBe('completed')
    expect(head(dir)).not.toBe(mainTip)

    await undo(dir)
    expect(head(dir)).toBe(mainTip)
    expect(status(dir).trim()).toBe('')
  })

  test('refuses (without changing HEAD) when local changes would be overwritten', async () => {
    const { dir, mainTip } = divergedRepo()
    await merge(dir, 'feature')
    const mergeTip = head(dir)
    // a.txt is "feature" from the merge; dirty it so undoing (which would set it
    // back toward the pre-merge state) cannot proceed without clobbering work.
    put(dir, 'a.txt', 'local edit')

    await expect(undo(dir)).rejects.toThrow(/uncommitted changes/i)
    // Nothing moved, and the undo is still on offer.
    expect(head(dir)).toBe(mergeTip)
    const snap = await readUndoSnapshot(dir, mergeTip, null)
    expect(snap?.kind).toBe('merge')
    // For completeness: the pre-merge tip is what a clean undo would restore.
    expect(mergeTip).not.toBe(mainTip)
  })
})

describe('undo rebase / reset / cherry-pick / revert', () => {
  test('rebase: restores the original branch tip', async () => {
    const dir = initRepo()
    put(dir, 'a.txt', 'base')
    rawCommit(dir, 'c0')
    git(dir, 'checkout', '-q', '-b', 'feature')
    put(dir, 'f.txt', 'feature')
    const featureTip = rawCommit(dir, 'feature change')
    git(dir, 'checkout', '-q', 'main')
    put(dir, 'm.txt', 'main')
    rawCommit(dir, 'main change')
    git(dir, 'checkout', '-q', 'feature')

    expect(await rebase(dir, 'main')).toBe('completed')
    expect(head(dir)).not.toBe(featureTip)
    await undo(dir)
    expect(head(dir)).toBe(featureTip)
  })

  test('reset: restores the tip a hard reset discarded', async () => {
    const dir = seedRepo()
    put(dir, 'b.txt', 'b')
    rawCommit(dir, 'c1')
    put(dir, 'c.txt', 'c')
    const tip = rawCommit(dir, 'c2')
    const c0 = git(dir, 'rev-parse', 'HEAD~2').trim()

    await reset(dir, c0, 'hard')
    expect(head(dir)).toBe(c0)
    await undo(dir)
    expect(head(dir)).toBe(tip)
    expect(status(dir).trim()).toBe('')
  })

  test('cherry-pick and revert each restore the prior tip', async () => {
    const dir = initRepo()
    put(dir, 'a.txt', 'base')
    rawCommit(dir, 'c0')
    git(dir, 'checkout', '-q', '-b', 'other')
    put(dir, 'o.txt', 'other')
    const pick = rawCommit(dir, 'other change')
    git(dir, 'checkout', '-q', 'main')
    const beforePick = head(dir)

    await cherryPick(dir, pick)
    expect(head(dir)).not.toBe(beforePick)
    expect((await undo(dir)).kind).toBe('cherry-pick')
    expect(head(dir)).toBe(beforePick)

    await revertCommit(dir, beforePick)
    expect(head(dir)).not.toBe(beforePick)
    expect((await undo(dir)).kind).toBe('revert')
    expect(head(dir)).toBe(beforePick)
  })
})

describe('readUndoSnapshot validity & snapshot integration', () => {
  test('offers a derived undo for an unrecorded commit (terminal / older session)', async () => {
    const dir = seedRepo()
    put(dir, 'foo.txt', 'hi')
    const c = rawCommit(dir, 'add foo') // committed outside GitGrove — no record

    const snap = await readUndoSnapshot(dir, c, null)
    expect(snap?.kind).toBe('commit')
    expect(snap?.label).toContain('add foo')
    expect(snap?.headSha).toBe(c)

    // ...and it actually reverts, handing back the message for the composer.
    const result = await undo(dir)
    expect(result.message).toBe('add foo')
    expect(head(dir)).not.toBe(c)
    expect(status(dir)).toContain('foo.txt')
  })

  test('a stale record falls through to the derived undo of the current commit', async () => {
    const dir = seedRepo()
    put(dir, 'foo.txt', 'hi')
    await commitSelection(dir, 'add foo', COMMIT_ALL) // records this commit
    put(dir, 'bar.txt', 'bye')
    const b = rawCommit(dir, 'add bar') // HEAD moves on — the record is now stale

    const snap = await readUndoSnapshot(dir, b, null)
    expect(snap?.kind).toBe('commit')
    expect(snap?.label).toContain('add bar')
    expect(snap?.headSha).toBe(b)
  })

  test('withholds undo once the commit is pushed (mirrors GitHub Desktop)', async () => {
    const dir = seedRepo()
    put(dir, 'foo.txt', 'hi')
    await commitSelection(dir, 'add foo', COMMIT_ALL)
    const tip = head(dir)

    // Upstream at the undone commit → pushed → no undo offered.
    git(dir, 'update-ref', 'refs/remotes/origin/main', tip)
    expect(await readUndoSnapshot(dir, tip, 'origin/main')).toBeNull()
    // Upstream one commit behind → unpushed → undo offered.
    git(dir, 'update-ref', 'refs/remotes/origin/main', `${tip}~1`)
    expect((await readUndoSnapshot(dir, tip, 'origin/main'))?.kind).toBe('commit')
  })

  test('treats a pushed commit as pushed when its configured upstream ref was deleted', async () => {
    // A stale branch still tracking a remote branch that no longer exists (the
    // remote deleted it, or renamed its default). git keeps reporting the
    // upstream (here 'origin/gone'), but the ref doesn't resolve — the tip must
    // still count as pushed via any *other* remote-tracking branch that has it.
    const dir = seedRepo()
    put(dir, 'foo.txt', 'hi')
    const tip = rawCommit(dir, 'add foo')
    // The commit lives on a real remote branch, but NOT on the (missing) upstream.
    git(dir, 'update-ref', 'refs/remotes/origin/main', tip)

    // Configured upstream 'origin/gone' has no ref: don't mistake the ancestor
    // probe's failure for "unpushed" — fall back to remote-containment.
    expect(await readUndoSnapshot(dir, tip, 'origin/gone')).toBeNull()
    // And the mutation refuses too (no record → derived path), rather than
    // rewriting published history.
    await expect(undo(dir)).rejects.toThrow(/nothing to undo/i)
    expect(head(dir)).toBe(tip)
  })

  test('the mutation refuses to undo a recorded op whose tip is already pushed', async () => {
    const dir = seedRepo()
    put(dir, 'foo.txt', 'hi')
    await commitSelection(dir, 'add foo', COMMIT_ALL) // records this commit
    const tip = head(dir)
    // Configure an upstream that already contains the tip → pushed.
    git(dir, 'update-ref', 'refs/remotes/origin/main', tip)
    git(dir, 'config', 'branch.main.remote', 'origin')
    git(dir, 'config', 'branch.main.merge', 'refs/heads/main')

    await expect(undo(dir)).rejects.toThrow(/already pushed/i)
    expect(head(dir)).toBe(tip) // nothing rewritten
  })

  test('a reset stays undoable even when its new tip is already pushed', async () => {
    const dir = seedRepo()
    put(dir, 'b.txt', 'b')
    rawCommit(dir, 'c1')
    const c0 = git(dir, 'rev-parse', 'HEAD~1').trim()

    await reset(dir, c0, 'mixed')
    expect(head(dir)).toBe(c0)
    // c0 is on the upstream, but undoing a reset only restores commits — it
    // never rewrites published history — so it's still offered.
    git(dir, 'update-ref', 'refs/remotes/origin/main', c0)
    expect((await readUndoSnapshot(dir, c0, 'origin/main'))?.kind).toBe('reset')
  })

  test('the repo snapshot carries the undo affordance', async () => {
    const dir = seedRepo()
    put(dir, 'foo.txt', 'hi')
    await commitSelection(dir, 'add foo', COMMIT_ALL)

    const snap = await getRepoSnapshot(dir)
    expect(snap.undo?.kind).toBe('commit')
    expect(snap.undo?.label).toContain('add foo')
  })
})
