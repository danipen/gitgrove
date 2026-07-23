import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  countConflictMarkers,
  getBlame,
  getBranches,
  getCommitFiles,
  getCommitIndex,
  getConflictSides,
  getFileHistory,
  getLog,
  getMergeBase,
  getMergePreview,
  getMergeToolName,
  getRangeFiles,
  getRemoteWebUrl,
  getUnpushedCommits,
  parseBlamePorcelain,
  parseMergeTreeNames,
  parseRawNumstat,
  parseRecentBranches,
  resolveRepoRoot,
  toWebUrl
} from './read'

// Integration tests: drive the real `git` binary against a throwaway repo so we
// exercise the same code path the app uses. CI runners ship git; if it's ever
// missing these will fail loudly rather than silently skip.

let repo: string
let firstHash: string
let secondHash: string
let renameHash: string

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
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

// Isolate git from the developer's machine config so these tests are hermetic:
// without this, an actual `merge.tool` in the user's global config leaks into
// getMergeToolName. Point global + system config at an empty file (cross-platform
// — `/dev/null` isn't valid on Windows CI). Both the `git()` helper and the
// product code under test inherit this via process.env.
let configHome: string

beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), 'gitgrove-config-'))
  const emptyConfig = join(configHome, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig

  repo = mkdtempSync(join(tmpdir(), 'gitgrove-test-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'commit.gpgsign', 'false'])

  writeFileSync(join(repo, 'README.md'), '# hello\n')
  writeFileSync(join(repo, 'keep.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'initial commit'])
  firstHash = git(['rev-parse', 'HEAD'])

  // Second commit: modify a file and add a new one, so getCommitFiles has
  // something with a couple of distinct statuses to report.
  writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'added.txt'), 'new\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'second commit'])
  secondHash = git(['rev-parse', 'HEAD'])

  // Third commit: a rename plus a non-ASCII filename — both break parsers that
  // read git's quoted, tab-separated output instead of `-z` NUL records.
  git(['mv', 'added.txt', 'moved.txt'])
  writeFileSync(join(repo, 'ümläut ñ.txt'), 'unicode\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'rename and unicode'])
  renameHash = git(['rev-parse', 'HEAD'])
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(configHome, { recursive: true, force: true })
  delete process.env.GIT_CONFIG_GLOBAL
  delete process.env.GIT_CONFIG_SYSTEM
})

describe('resolveRepoRoot', () => {
  it('resolves the top-level dir from a nested path', async () => {
    const root = await resolveRepoRoot(repo)
    // macOS tmpdir is symlinked (/var → /private/var); compare basenames.
    expect(root).not.toBeNull()
    expect(git(['rev-parse', '--show-toplevel'])).toBe(root!)
  })

  it('returns null outside a repo', async () => {
    expect(await resolveRepoRoot(tmpdir())).toBeNull()
  })
})

describe('getCommitIndex', () => {
  it("returns a commit's 0-based position in git log HEAD", async () => {
    // History (newest first): renameHash, secondHash, firstHash.
    expect(await getCommitIndex(repo, renameHash)).toBe(0)
    expect(await getCommitIndex(repo, secondHash)).toBe(1)
    expect(await getCommitIndex(repo, firstHash)).toBe(2)
  })

  it('returns -1 for a commit that is not an ancestor of HEAD', async () => {
    // A commit on a side branch never merged into main would never appear in
    // `git log HEAD`, so there's no position to page to.
    git(['checkout', '-q', '-b', 'side-index'])
    writeFileSync(join(repo, 'side.txt'), 'side\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'side commit'])
    const sideHash = git(['rev-parse', 'HEAD'])
    git(['checkout', '-q', 'main'])
    try {
      expect(await getCommitIndex(repo, sideHash)).toBe(-1)
    } finally {
      git(['branch', '-q', '-D', 'side-index'])
    }
  })
})

describe('getBranches', () => {
  it('reports the current branch', async () => {
    const branches = await getBranches(repo)
    expect(branches.current).toBe('main')
    expect(branches.detached).toBe(false)
    expect(branches.local).toContain('main')
  })

  it('resolves the default branch and recent checkouts', async () => {
    // Bounce through two branches so the reflog records the checkouts; end on
    // main so the other tests keep seeing the expected HEAD.
    git(['checkout', '-q', '-b', 'feature/recent-a'])
    git(['checkout', '-q', '-b', 'feature/recent-b'])
    git(['checkout', '-q', 'feature/recent-a'])
    git(['checkout', '-q', 'main'])
    try {
      const branches = await getBranches(repo)
      // No origin/HEAD in a local-only repo — the main/master fallback applies.
      expect(branches.defaultBranch).toBe('main')
      // Most recent checkout first; current (main) and default excluded.
      expect(branches.recent).toEqual(['feature/recent-a', 'feature/recent-b'])
    } finally {
      git(['branch', '-q', '-D', 'feature/recent-a', 'feature/recent-b'])
    }
  })
})

describe('parseRecentBranches', () => {
  // Reflog subjects arrive newest-first, exactly as `reflog --format=%gs`.
  const reflog = [
    'checkout: moving from feature/x to fix/y',
    'commit: change something',
    'checkout: moving from main to feature/x',
    'checkout: moving from feature/x to main',
    'checkout: moving from abc1234 to feature/x',
    'checkout: moving from main to abc1234'
  ].join('\n')

  it('returns checkout targets newest-first, deduplicated', () => {
    const recent = parseRecentBranches(reflog, new Set(['feature/x', 'fix/y', 'main']))
    expect(recent).toEqual(['fix/y', 'feature/x', 'main'])
  })

  it('drops targets that are not candidates (deleted branches, detached hashes)', () => {
    const recent = parseRecentBranches(reflog, new Set(['feature/x']))
    expect(recent).toEqual(['feature/x'])
  })

  it('honours the limit', () => {
    const recent = parseRecentBranches(reflog, new Set(['feature/x', 'fix/y', 'main']), 2)
    expect(recent).toEqual(['fix/y', 'feature/x'])
  })

  it('returns nothing for an empty reflog', () => {
    expect(parseRecentBranches('', new Set(['main']))).toEqual([])
  })
})

describe('getLog', () => {
  it('returns commits newest-first with parsed metadata', async () => {
    const log = await getLog(repo)
    expect(log.length).toBe(3)
    expect(log[0].subject).toBe('rename and unicode')
    expect(log[1].subject).toBe('second commit')
    expect(log[2].subject).toBe('initial commit')
    expect(log[0].authorName).toBe('Test Author')
    expect(log[0].authorEmail).toBe('author@example.com')
    // The root commit has no parents; the others have exactly one.
    expect(log[1].parents).toEqual([firstHash])
    expect(log[2].parents).toEqual([])
  })

  it('honours the limit option', async () => {
    const log = await getLog(repo, { limit: 1 })
    expect(log.length).toBe(1)
    expect(log[0].subject).toBe('rename and unicode')
  })

  it('filters by message with search', async () => {
    const log = await getLog(repo, { search: 'initial' })
    expect(log.map((c) => c.subject)).toEqual(['initial commit'])
  })

  it('matches search case-insensitively', async () => {
    const log = await getLog(repo, { search: 'INITIAL' })
    expect(log.map((c) => c.subject)).toEqual(['initial commit'])
  })

  it('requires every whitespace-separated term to match', async () => {
    // Both words live in the same message; word order in the query is irrelevant.
    expect((await getLog(repo, { search: 'rename unicode' })).map((c) => c.subject)).toEqual([
      'rename and unicode'
    ])
    // A term absent from any single message yields no results (terms are ANDed).
    expect(await getLog(repo, { search: 'rename second' })).toEqual([])
  })

  it('treats the query as literal text, not a regex', async () => {
    // `.` is a regex wildcard; as a fixed string it matches nothing here.
    expect(await getLog(repo, { search: 'initial.commit' })).toEqual([])
  })

  it('finds a commit by its full or abbreviated hash', async () => {
    const initial = (await getLog(repo)).at(-1)
    if (!initial) throw new Error('missing commit')
    // A hash never appears in the message, so --grep alone would yield [].
    expect((await getLog(repo, { search: initial.hash })).map((c) => c.hash)).toEqual([
      initial.hash
    ])
    // Abbreviated and uppercase ids resolve too (rev-parse semantics).
    const abbrev = initial.hash.slice(0, 7).toUpperCase()
    expect((await getLog(repo, { search: abbrev })).map((c) => c.hash)).toEqual([initial.hash])
  })
})

describe('toWebUrl', () => {
  it('converts scp-like SSH remotes to https', () => {
    expect(toWebUrl('git@github.com:danipen/gitgrove.git')).toBe(
      'https://github.com/danipen/gitgrove'
    )
  })

  it('converts ssh:// remotes, dropping creds and port', () => {
    expect(toWebUrl('ssh://git@github.com:22/danipen/gitgrove.git')).toBe(
      'https://github.com/danipen/gitgrove'
    )
  })

  it('upgrades git:// and http:// to https and strips .git', () => {
    expect(toWebUrl('git://gitlab.com/group/proj.git')).toBe('https://gitlab.com/group/proj')
    expect(toWebUrl('http://example.com/a/b.git')).toBe('https://example.com/a/b')
  })

  it('passes through a clean https remote', () => {
    expect(toWebUrl('https://github.com/danipen/gitgrove.git')).toBe(
      'https://github.com/danipen/gitgrove'
    )
  })

  it('returns null for non-browsable or empty remotes', () => {
    expect(toWebUrl('/srv/git/repo.git')).toBeNull()
    expect(toWebUrl('')).toBeNull()
    expect(toWebUrl('https://github.com')).toBeNull()
  })
})

describe('getRemoteWebUrl', () => {
  it('resolves the origin remote to a web URL', async () => {
    git(['remote', 'add', 'origin', 'git@github.com:danipen/gitgrove.git'])
    try {
      expect(await getRemoteWebUrl(repo)).toBe('https://github.com/danipen/gitgrove')
    } finally {
      git(['remote', 'remove', 'origin'])
    }
  })

  it('returns null when the repo has no remote', async () => {
    expect(await getRemoteWebUrl(repo)).toBeNull()
  })
})

describe('getCommitFiles', () => {
  it('lists files changed in a commit with status and line counts', async () => {
    const files = await getCommitFiles(repo, secondHash)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
    expect(byPath['added.txt'].status).toBe('added')
    expect(byPath['keep.txt'].status).toBe('modified')
    expect(byPath['keep.txt'].insertions).toBe(1)
    expect(byPath['keep.txt'].deletions).toBe(0)
  })

  it('reports renames with both paths and exact unicode filenames', async () => {
    const files = await getCommitFiles(repo, renameHash)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
    expect(byPath['moved.txt'].status).toBe('renamed')
    expect(byPath['moved.txt'].oldPath).toBe('added.txt')
    expect(byPath['ümläut ñ.txt'].status).toBe('added')
    expect(byPath['ümläut ñ.txt'].insertions).toBe(1)
  })

  it('treats every file in a root commit as added', async () => {
    const files = await getCommitFiles(repo, firstHash)
    const statuses = new Set(files.map((f) => f.status))
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'keep.txt'])
    expect([...statuses]).toEqual(['added'])
  })
})

describe('getMergeBase', () => {
  let branchRepo: string
  let forkPoint: string
  let mainTip: string

  beforeAll(() => {
    // A feature branch that merged its upstream back in — the update-merge a
    // long-lived branch does to stay current. The fork point no longer tells
    // the truth about "what the branch changed"; the merge base does.
    branchRepo = mkdtempSync(join(tmpdir(), 'gitgrove-mergebase-'))
    git(['init', '-q', '-b', 'main'], branchRepo)
    git(['config', 'commit.gpgsign', 'false'], branchRepo)
    writeFileSync(join(branchRepo, 'base.txt'), 'base\n')
    git(['add', '.'], branchRepo)
    git(['commit', '-q', '-m', 'base'], branchRepo)
    forkPoint = git(['rev-parse', 'HEAD'], branchRepo)
    git(['checkout', '-q', '-b', 'feature'], branchRepo)
    writeFileSync(join(branchRepo, 'feature.txt'), 'feature\n')
    git(['add', '.'], branchRepo)
    git(['commit', '-q', '-m', 'feature work'], branchRepo)
    git(['checkout', '-q', 'main'], branchRepo)
    writeFileSync(join(branchRepo, 'mainline.txt'), 'mainline\n')
    git(['add', '.'], branchRepo)
    git(['commit', '-q', '-m', 'mainline work'], branchRepo)
    mainTip = git(['rev-parse', 'HEAD'], branchRepo)
    git(['checkout', '-q', 'feature'], branchRepo)
    git(['merge', '-q', '--no-edit', 'main'], branchRepo)
  })

  afterAll(() => {
    rmSync(branchRepo, { recursive: true, force: true })
  })

  it('finds the last commit two branches agreed on', async () => {
    expect(await getMergeBase(branchRepo, 'main', 'feature')).toBe(mainTip)
  })

  it("diffs only the branch's own work from the merge base", async () => {
    // From the fork point the range over-counts: it includes the mainline
    // work the branch merged back in…
    const fromFork = await getRangeFiles(branchRepo, forkPoint, 'feature')
    expect(fromFork.map((f) => f.path)).toEqual(['feature.txt', 'mainline.txt'])
    // …from the merge base it is exactly the branch's own changes — what the
    // branch's pull request shows.
    const base = await getMergeBase(branchRepo, 'main', 'feature')
    const own = await getRangeFiles(branchRepo, base, 'feature')
    expect(own.map((f) => f.path)).toEqual(['feature.txt'])
  })

  it('returns null when the commits share no history', async () => {
    git(['checkout', '-q', '--orphan', 'unrelated'], branchRepo)
    git(['commit', '-q', '-m', 'unrelated root'], branchRepo)
    expect(await getMergeBase(branchRepo, 'main', 'unrelated')).toBeNull()
  })
})

describe('parseRawNumstat', () => {
  it('marks gitlink (mode 160000) entries as submodules', () => {
    const raw = [
      ':160000 160000 aaaaaaa bbbbbbb M',
      'libs/engine',
      ':000000 160000 0000000 ccccccc A',
      'libs/new-sub',
      ':100644 100644 ddddddd eeeeeee M',
      'src/file.ts',
      '-\t-\tlibs/engine',
      '-\t-\tlibs/new-sub',
      '3\t1\tsrc/file.ts'
    ].join('\0')
    const files = parseRawNumstat(raw)
    expect(files.map((f) => [f.path, f.submodule ?? false])).toEqual([
      ['libs/engine', true],
      ['libs/new-sub', true],
      ['src/file.ts', false]
    ])
  })
})

describe('parseMergeTreeNames', () => {
  it('returns conflicted paths after the tree oid line', () => {
    const out = 'abc123def\nsrc/app.ts\nREADME.md\n'
    expect(parseMergeTreeNames(out)).toEqual(['src/app.ts', 'README.md'])
  })

  it('returns nothing for a clean merge (oid only)', () => {
    expect(parseMergeTreeNames('abc123def\n')).toEqual([])
  })
})

describe('countConflictMarkers', () => {
  it('counts only line-leading <<<<<<< markers', () => {
    const contents = [
      'line',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> feature',
      'text with <<<<<<< inside',
      '<<<<<<< HEAD',
      'more',
      '>>>>>>> feature'
    ].join('\n')
    expect(countConflictMarkers(contents)).toBe(2)
  })

  it('reports zero for resolved content', () => {
    expect(countConflictMarkers('all good\nno markers\n')).toBe(0)
  })
})

describe('merge preview & conflict sides', () => {
  let mergeRepo: string

  // `merge-tree --write-tree` needs git ≥ 2.38; the preview degrades to
  // 'unknown' on older gits, which the last test covers either way.
  const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' })
  const [major, minor] = (gitVersion.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
  const hasMergeTree = major > 2 || (major === 2 && minor >= 38)

  beforeAll(() => {
    mergeRepo = mkdtempSync(join(tmpdir(), 'gitgrove-preview-'))
    git(['init', '-q', '-b', 'main'], mergeRepo)
    git(['config', 'commit.gpgsign', 'false'], mergeRepo)
    writeFileSync(join(mergeRepo, 'shared.txt'), 'base\n')
    git(['add', '.'], mergeRepo)
    git(['commit', '-q', '-m', 'base'], mergeRepo)
    git(['branch', 'past'], mergeRepo)
    // Clean branch: adds an unrelated file.
    git(['checkout', '-q', '-b', 'clean-add'], mergeRepo)
    writeFileSync(join(mergeRepo, 'clean.txt'), 'clean\n')
    git(['add', '.'], mergeRepo)
    git(['commit', '-q', '-m', 'clean add'], mergeRepo)
    // Colliding branch: edits the same line main edits.
    git(['checkout', '-q', '-b', 'collide', 'main'], mergeRepo)
    writeFileSync(join(mergeRepo, 'shared.txt'), 'theirs\n')
    git(['commit', '-q', '-am', 'theirs'], mergeRepo)
    git(['checkout', '-q', 'main'], mergeRepo)
    writeFileSync(join(mergeRepo, 'shared.txt'), 'ours\n')
    git(['commit', '-q', '-am', 'ours'], mergeRepo)
  })

  afterAll(() => {
    rmSync(mergeRepo, { recursive: true, force: true })
  })

  it('reports up-to-date when the branch is already contained', async () => {
    const preview = await getMergePreview(mergeRepo, 'past')
    expect(preview).toEqual({ outcome: 'up-to-date', conflictedPaths: [], commitCount: 0 })
  })

  it.skipIf(!hasMergeTree)('predicts a clean merge without touching the working tree', async () => {
    const preview = await getMergePreview(mergeRepo, 'clean-add')
    expect(preview.outcome).toBe('clean')
    expect(preview.commitCount).toBe(1)
    expect(git(['status', '--porcelain'], mergeRepo)).toBe('')
  })

  it.skipIf(!hasMergeTree)('predicts conflicts and names the files', async () => {
    const preview = await getMergePreview(mergeRepo, 'collide')
    expect(preview.outcome).toBe('conflicts')
    expect(preview.conflictedPaths).toEqual(['shared.txt'])
    expect(git(['status', '--porcelain'], mergeRepo)).toBe('')
  })

  it.skipIf(hasMergeTree)('degrades to unknown on gits without merge-tree', async () => {
    const preview = await getMergePreview(mergeRepo, 'collide')
    expect(preview.outcome).toBe('unknown')
    expect(preview.commitCount).toBe(1)
  })

  it('returns all three versions and the marker count of a live conflict', async () => {
    try {
      git(['merge', 'collide'], mergeRepo)
    } catch {
      /* exits non-zero on conflict — expected */
    }
    const sides = await getConflictSides(mergeRepo, 'shared.txt')
    expect(sides.base).toBe('base\n')
    expect(sides.ours).toBe('ours\n')
    expect(sides.theirs).toBe('theirs\n')
    expect(sides.oursDeleted).toBe(false)
    expect(sides.theirsDeleted).toBe(false)
    expect(sides.binary).toBe(false)
    expect(sides.markerCount).toBe(1)
    git(['merge', '--abort'], mergeRepo)
  })

  it('reads the configured merge tool name, null when unset', async () => {
    expect(await getMergeToolName(mergeRepo)).toBeNull()
    git(['config', 'merge.tool', 'meld'], mergeRepo)
    try {
      expect(await getMergeToolName(mergeRepo)).toBe('meld')
    } finally {
      git(['config', '--unset', 'merge.tool'], mergeRepo)
    }
  })
})

describe('getFileHistory', () => {
  it('lists commits that touched a file, newest first', async () => {
    const log = await getFileHistory(repo, 'keep.txt')
    expect(log.map((c) => c.subject)).toEqual(['second commit', 'initial commit'])
  })

  it('follows renames back through the old path', async () => {
    // moved.txt was added as added.txt (second commit) then renamed (third).
    const log = await getFileHistory(repo, 'moved.txt')
    expect(log.map((c) => c.subject)).toEqual(['rename and unicode', 'second commit'])
  })
})

describe('getBlame', () => {
  let blameRepo: string

  // Two authors, a modify+add, and a rename — enough to exercise the line→commit
  // mapping, author attribution, `previous`/`filename`, boundary, and the
  // working-tree "Not Committed Yet" case.
  function commit(cwd: string, name: string, email: string, message: string): void {
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email
      }
    })
  }

  let shaA: string
  let shaB: string

  beforeAll(() => {
    blameRepo = mkdtempSync(join(tmpdir(), 'gitgrove-blame-'))
    git(['init', '-q', '-b', 'main'], blameRepo)
    git(['config', 'commit.gpgsign', 'false'], blameRepo)

    writeFileSync(join(blameRepo, 'file.txt'), 'alpha\nbeta\n')
    git(['add', '.'], blameRepo)
    commit(blameRepo, 'Alice', 'alice@example.com', 'A')
    shaA = git(['rev-parse', 'HEAD'], blameRepo)

    writeFileSync(join(blameRepo, 'file.txt'), 'alpha\nBETA\ngamma\n')
    git(['add', '.'], blameRepo)
    commit(blameRepo, 'Bob', 'bob@example.com', 'B')
    shaB = git(['rev-parse', 'HEAD'], blameRepo)

    git(['mv', 'file.txt', 'renamed.txt'], blameRepo)
    commit(blameRepo, 'Alice', 'alice@example.com', 'C rename')
  })

  afterAll(() => {
    rmSync(blameRepo, { recursive: true, force: true })
  })

  it('maps each line to the commit and author that last touched it', async () => {
    const lines = await getBlame(blameRepo, 'renamed.txt')
    expect(lines.map((l) => l.content)).toEqual(['alpha', 'BETA', 'gamma'])
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3])
    expect(lines[0].hash).toBe(shaA)
    expect(lines[0].authorName).toBe('Alice')
    expect(lines[1].hash).toBe(shaB)
    expect(lines[1].authorName).toBe('Bob')
    expect(lines[2].hash).toBe(shaB)
  })

  it('marks the root commit as a boundary with no prior version', async () => {
    const lines = await getBlame(blameRepo, 'renamed.txt')
    // alpha was introduced in the root commit A — nothing earlier to blame.
    expect(lines[0].isBoundary).toBe(true)
    expect(lines[0].previous).toBeUndefined()
    // BETA's prior version lives in A under the pre-rename path.
    expect(lines[1].previous?.hash).toBe(shaA)
    expect(lines[1].previous?.filename).toBe('file.txt')
    expect(lines[1].filename).toBe('file.txt')
  })

  it('flags uncommitted working-tree lines', async () => {
    writeFileSync(join(blameRepo, 'renamed.txt'), 'alpha\nBETA\ngamma\ndelta\n')
    try {
      const lines = await getBlame(blameRepo, 'renamed.txt')
      const delta = lines.find((l) => l.content === 'delta')
      expect(delta?.notCommitted).toBe(true)
    } finally {
      // Restore so other assertions on this repo stay deterministic.
      git(['checkout', '--', 'renamed.txt'], blameRepo)
    }
  })

  it('blames a historical revision', async () => {
    // At commit A the file had two lines, both authored by Alice.
    const lines = await getBlame(blameRepo, 'file.txt', shaA)
    expect(lines.map((l) => l.content)).toEqual(['alpha', 'beta'])
    expect(lines.every((l) => l.authorName === 'Alice')).toBe(true)
  })
})

describe('parseBlamePorcelain', () => {
  it('reuses cached commit metadata across repeated lines', () => {
    const sha = 'a'.repeat(40)
    // Porcelain emits the full header once, then an abbreviated header for the
    // commit's later lines (no repeated metadata).
    const out = [
      `${sha} 1 1 2`,
      'author Dana',
      'author-mail <dana@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'summary first',
      'filename file.txt',
      '\tline one',
      `${sha} 2 2`,
      '\tline two',
      ''
    ].join('\n')
    const lines = parseBlamePorcelain(out)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ lineNumber: 1, content: 'line one', authorName: 'Dana' })
    expect(lines[1]).toMatchObject({ lineNumber: 2, content: 'line two', authorName: 'Dana' })
    expect(lines[1].shortHash).toBe('aaaaaaa')
  })
})

describe('getUnpushedCommits', () => {
  // Its own repo + bare remote so the push/no-push states are exact and the
  // shared fixture (which has no remote and side branches) stays untouched.
  let work: string
  let remote: string

  beforeAll(() => {
    remote = mkdtempSync(join(tmpdir(), 'gitgrove-remote-'))
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    work = mkdtempSync(join(tmpdir(), 'gitgrove-unpushed-'))
    const run = (args: string[]) => git(args, work)
    run(['init', '-q', '-b', 'main'])
    run(['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(work, 'a.txt'), 'a\n')
    run(['add', '.'])
    run(['commit', '-q', '-m', 'first'])
    run(['remote', 'add', 'origin', remote])
    run(['push', '-q', '-u', 'origin', 'main'])
  })

  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('is empty when every commit is on the remote', async () => {
    expect(await getUnpushedCommits(work)).toEqual([])
  })

  it('lists local commits not yet on any remote', async () => {
    const run = (args: string[]) => git(args, work)
    writeFileSync(join(work, 'b.txt'), 'b\n')
    run(['add', '.'])
    run(['commit', '-q', '-m', 'local on main'])
    const onMain = run(['rev-parse', 'HEAD'])

    // A commit on a second local branch is unpushed too — `--branches` spans
    // every local branch, not just the one HEAD points at.
    run(['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(work, 'c.txt'), 'c\n')
    run(['add', '.'])
    run(['commit', '-q', '-m', 'local on feature'])
    const onFeature = run(['rev-parse', 'HEAD'])
    run(['checkout', '-q', 'main'])

    const unpushed = await getUnpushedCommits(work)
    expect(new Set(unpushed)).toEqual(new Set([onMain, onFeature]))
  })

  it('returns [] outside a repo rather than throwing', async () => {
    expect(await getUnpushedCommits(tmpdir())).toEqual([])
  })
})
