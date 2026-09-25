import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRefs, parseRefs } from './refs'

describe('parseRefs', () => {
  it('shortens names, peels annotated tags and skips symbolic refs', () => {
    const out = [
      'refs/heads/main\x00aaa\x00\x00100\x00',
      'refs/remotes/origin/HEAD\x00aaa\x00\x00100\x00refs/remotes/origin/main',
      'refs/remotes/origin/main\x00aaa\x00\x00100\x00',
      'refs/tags/v1\x00tagobj\x00ccc\x00200\x00',
      'refs/tags/light\x00ddd\x00\x00300\x00',
      ''
    ].join('\n')
    expect(parseRefs(out)).toEqual([
      { kind: 'local', name: 'main', hash: 'aaa', date: 100 },
      { kind: 'remote', name: 'origin/main', hash: 'aaa', date: 100 },
      { kind: 'tag', name: 'v1', hash: 'ccc', date: 200 },
      { kind: 'tag', name: 'light', hash: 'ddd', date: 300 }
    ])
  })
})

// Integration: the real `git` binary against a throwaway, hermetic repo.
let repo: string
let configHome: string

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
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-config-'))
  const emptyConfig = join(configHome, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig

  repo = mkdtempSync(join(tmpdir(), 'gitgrove-refs-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'tag.gpgsign', 'false'])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'first'])
  git(['branch', 'feature/x'])
  git(['tag', '-a', 'v1.0', '-m', 'release'])
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(configHome, { recursive: true, force: true })
})

describe('getRefs', () => {
  it('lists branches and tags, annotated tags peeled to their commit', async () => {
    const head = git(['rev-parse', 'HEAD'])
    const refs = await getRefs(repo)
    const byName = new Map(refs.map((r) => [r.name, r]))
    expect(byName.get('main')).toMatchObject({ kind: 'local', hash: head })
    expect(byName.get('feature/x')).toMatchObject({ kind: 'local', hash: head })
    expect(byName.get('v1.0')).toMatchObject({ kind: 'tag', hash: head })
    expect(byName.get('v1.0')!.date).toBeGreaterThan(0)
  })
})
