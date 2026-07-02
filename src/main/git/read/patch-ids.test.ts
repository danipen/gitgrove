import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPatchIds } from './patch-ids'

// Integration tests: drive the real `git` binary against a throwaway repo —
// the scenario the backport twins exist for: a fix lands on main and is
// cherry-picked onto the 11.x maintenance branch.

let repo: string
let configHome: string
let fixHash: string
let backportHash: string
let otherHash: string
let mergeHash: string

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.com'
    }
  }).trim()
}

beforeAll(() => {
  // Hermetic git: point global + system config at an empty file so the
  // developer's machine config never leaks in (see read.test.ts).
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-config-'))
  const emptyConfig = join(configHome, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig

  repo = mkdtempSync(join(tmpdir(), 'gitgrove-patchid-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'user.name', 'Test Author'])
  git(['config', 'user.email', 'author@example.com'])

  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'initial'])
  git(['branch', '11.x'])

  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'fix crash'])
  fixHash = git(['rev-parse', 'HEAD'])

  writeFileSync(join(repo, 'b.txt'), 'other\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'unrelated change'])
  otherHash = git(['rev-parse', 'HEAD'])

  git(['checkout', '-q', '11.x'])
  git(['cherry-pick', fixHash])
  backportHash = git(['rev-parse', 'HEAD'])

  // A merge for the "merges drop out" case (clean: a.txt agrees on both sides).
  git(['merge', '--no-ff', '-q', '-m', 'merge main up', 'main'])
  mergeHash = git(['rev-parse', 'HEAD'])
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(configHome, { recursive: true, force: true })
})

describe('getPatchIds', () => {
  it('gives a cherry-picked backport the same patch-id as its source', async () => {
    const ids = await getPatchIds(repo, [fixHash, backportHash, otherHash, mergeHash])
    expect(ids[fixHash]).toBe(ids[backportHash])
    expect(ids[fixHash] === ids[otherHash]).toBe(false)
    // Merges produce no diff in stdin mode and simply drop out.
    expect(mergeHash in ids).toBe(false)
  })

  it('returns an empty record for an empty request', async () => {
    expect(await getPatchIds(repo, [])).toEqual({})
  })

  it('drops unknown hashes instead of failing the whole batch', async () => {
    // diff-tree --stdin ignores lines it can't resolve (exit 0) — right for a
    // best-effort decoration: one stale hash must not cost every link.
    const ids = await getPatchIds(repo, ['0'.repeat(40), fixHash])
    expect('0'.repeat(40) in ids).toBe(false)
    expect(typeof ids[fixHash]).toBe('string')
  })
})
