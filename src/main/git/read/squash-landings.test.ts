import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SquashCandidate } from '@shared/types'
import { getSquashLandings } from './squash-landings'

// Integration tests: drive the real `git` binary against a throwaway repo —
// the pull-request host's merge buttons replayed locally: a two-commit branch
// squash-merged, a branch rebase-merged, and a branch that never landed.

let repo: string
let configHome: string
let squashedTip: string
let squashCommit: string
let rebasedTip: string
let rebaseLanding: string
let openTip: string

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

function commitFile(name: string, content: string, message: string): string {
  writeFileSync(join(repo, name), content)
  git(['add', '.'])
  git(['commit', '-q', '-m', message])
  return git(['rev-parse', 'HEAD'])
}

const mainline = () => git(['rev-list', '--first-parent', 'main']).split('\n')
const candidate = (tip: string): SquashCandidate => ({
  tip,
  base: git(['merge-base', 'main', tip])
})

beforeAll(() => {
  // Hermetic git: point global + system config at an empty file so the
  // developer's machine config never leaks in (see read.test.ts).
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-config-'))
  const emptyConfig = join(configHome, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig

  repo = mkdtempSync(join(tmpdir(), 'gitgrove-squash-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'commit.gpgsign', 'false'])
  commitFile('a.txt', 'one\n', 'initial')

  git(['checkout', '-q', '-b', 'feature'])
  commitFile('f.txt', 'first\n', 'feature part 1')
  squashedTip = commitFile('f.txt', 'first\nsecond\n', 'feature part 2')

  git(['checkout', '-q', '-b', 'rebased', 'main'])
  rebasedTip = commitFile('r.txt', 'rebased\n', 'rebased change')

  git(['checkout', '-q', '-b', 'open', 'main'])
  openTip = commitFile('o.txt', 'still open\n', 'open change')

  // The mainline moves on before anything lands, then takes both branches.
  git(['checkout', '-q', 'main'])
  commitFile('a.txt', 'one\ntwo\n', 'unrelated mainline work')
  git(['merge', '-q', '--squash', 'feature'])
  git(['commit', '-q', '-m', 'Feature (#1)'])
  squashCommit = git(['rev-parse', 'HEAD'])
  git(['cherry-pick', rebasedTip])
  rebaseLanding = git(['rev-parse', 'HEAD'])
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(configHome, { recursive: true, force: true })
})

describe('getSquashLandings', () => {
  it('finds the squash commit carrying a whole multi-commit branch', async () => {
    const landings = await getSquashLandings(repo, mainline(), [candidate(squashedTip)])
    expect(landings).toEqual({ [squashedTip]: squashCommit })
  })

  it('finds a rebase merge by the replayed tip commit', async () => {
    const landings = await getSquashLandings(repo, mainline(), [candidate(rebasedTip)])
    expect(landings).toEqual({ [rebasedTip]: rebaseLanding })
  })

  it('leaves a branch that never landed out of the result', async () => {
    const landings = await getSquashLandings(repo, mainline(), [
      candidate(openTip),
      candidate(squashedTip)
    ])
    expect(openTip in landings).toBe(false)
    expect(landings[squashedTip]).toBe(squashCommit)
  })

  it('ignores mainline commits older than the branch base', async () => {
    // Only the base itself and older are searched here: nothing can match.
    const base = git(['merge-base', 'main', squashedTip])
    const landings = await getSquashLandings(repo, mainline().slice(mainline().indexOf(base)), [
      { tip: squashedTip, base }
    ])
    expect(landings).toEqual({})
  })

  it('returns an empty record for an empty request', async () => {
    expect(await getSquashLandings(repo, mainline(), [])).toEqual({})
    expect(await getSquashLandings(repo, [], [candidate(squashedTip)])).toEqual({})
  })
})
