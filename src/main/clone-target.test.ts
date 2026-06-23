import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneTargetState, expandHome } from './clone-target'

describe('expandHome', () => {
  test('expands a leading ~ to the home directory', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome(join('~', 'Projects', 'x'))).toBe(join(homedir(), 'Projects', 'x'))
  })

  test('leaves absolute paths and mid-string tildes untouched', () => {
    const abs = join(tmpdir(), 'somewhere')
    expect(expandHome(abs)).toBe(abs)
    expect(expandHome('/a/~b')).toBe('/a/~b')
  })
})

describe('cloneTargetState', () => {
  test('a missing path is ok (git creates it)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'gg-clone-'))
    expect(await cloneTargetState(join(base, 'does-not-exist'))).toBe('ok')
  })

  test('an empty directory is ok', async () => {
    const base = await mkdtemp(join(tmpdir(), 'gg-clone-'))
    const empty = join(base, 'empty')
    await mkdir(empty)
    expect(await cloneTargetState(empty)).toBe('ok')
  })

  test('a directory with contents is not-empty', async () => {
    const base = await mkdtemp(join(tmpdir(), 'gg-clone-'))
    await writeFile(join(base, 'keep.txt'), 'hi')
    expect(await cloneTargetState(base)).toBe('not-empty')
  })

  test('a file at the path reads as file', async () => {
    const base = await mkdtemp(join(tmpdir(), 'gg-clone-'))
    const file = join(base, 'a-file')
    await writeFile(file, 'hi')
    expect(await cloneTargetState(file)).toBe('file')
  })
})
