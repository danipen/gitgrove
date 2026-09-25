import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchFiles } from './file-index'

// Integration tests: the real `git` binary against a throwaway repo, with
// global/system config pointed at an empty file so the developer's own config
// can't leak in.

let repo: string
let configHome: string

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function addFile(path: string) {
  const parts = path.split('/')
  if (parts.length > 1) mkdirSync(join(repo, ...parts.slice(0, -1)), { recursive: true })
  writeFileSync(join(repo, ...parts), `${path}\n`)
}

beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-config-'))
  const emptyConfig = join(configHome, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig

  repo = mkdtempSync(join(tmpdir(), 'gitgrove-files-'))
  git(['init', '-q', '-b', 'main'])
  for (const path of [
    'README.md',
    'src/components/GraphView.tsx',
    'src/graphics/old/view.ts',
    'docs/ümläut guide.md'
  ]) {
    addFile(path)
  }
  git(['add', '.'])
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(configHome, { recursive: true, force: true })
})

describe('searchFiles', () => {
  it('ranks the file-name match first and reports positions', async () => {
    const result = await searchFiles(repo, 'graphview', 10, 'ranking')
    expect(result?.matches[0].path).toBe('src/components/GraphView.tsx')
    const { path, positions } = result!.matches[0]
    expect(positions.map((i) => path[i]).join('')).toBe('GraphView')
  })

  it('counts every match while returning at most `limit`', async () => {
    const result = await searchFiles(repo, 'e', 1, 'limit')
    expect(result?.matches).toHaveLength(1)
    expect(result!.total).toBeGreaterThan(1)
  })

  it('matches non-ASCII paths exactly', async () => {
    const result = await searchFiles(repo, 'ümläut', 10, 'unicode')
    expect(result?.matches.map((m) => m.path)).toEqual(['docs/ümläut guide.md'])
  })

  it('returns nothing for an empty query', async () => {
    expect(await searchFiles(repo, '   ', 10, 'empty')).toEqual({ matches: [], total: 0 })
  })

  it('picks up newly tracked files once the index changes', async () => {
    expect((await searchFiles(repo, 'freshfile', 10, 'fresh'))?.matches).toHaveLength(0)
    addFile('lib/fresh-file.ts')
    git(['add', 'lib/fresh-file.ts'])
    const result = await searchFiles(repo, 'freshfile', 10, 'fresh')
    expect(result?.matches.map((m) => m.path)).toEqual(['lib/fresh-file.ts'])
  })

  it('abandons a query superseded by the same caller', async () => {
    const older = searchFiles(repo, 'graph', 10, 'typist')
    const newer = searchFiles(repo, 'graphv', 10, 'typist')
    expect(await older).toBeNull()
    expect((await newer)?.matches[0].path).toBe('src/components/GraphView.tsx')
  })

  it('never lets one caller cancel another', async () => {
    const [a, b] = await Promise.all([
      searchFiles(repo, 'readme', 10, 'window-a'),
      searchFiles(repo, 'readme', 10, 'window-b')
    ])
    expect(a?.matches[0].path).toBe('README.md')
    expect(b?.matches[0].path).toBe('README.md')
  })
})
