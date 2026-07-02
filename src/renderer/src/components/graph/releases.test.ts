import { describe, expect, test } from 'bun:test'
import { compareReleaseVersions, releaseLineVersion } from './releases'

describe('releaseLineVersion', () => {
  test('version-shaped names are release lines', () => {
    expect(releaseLineVersion('11.x')).toEqual([11])
    expect(releaseLineVersion('1.2.x')).toEqual([1, 2])
    expect(releaseLineVersion('2022.3')).toEqual([2022, 3])
    expect(releaseLineVersion('v10')).toEqual([10])
    expect(releaseLineVersion('V10.1')).toEqual([10, 1])
  })

  test('release namespaces are release lines, version digits optional', () => {
    expect(releaseLineVersion('release/2.3')).toEqual([2, 3])
    expect(releaseLineVersion('releases/11')).toEqual([11])
    expect(releaseLineVersion('rel-1.0')).toEqual([1, 0])
    expect(releaseLineVersion('support/2022.3')).toEqual([2022, 3])
    expect(releaseLineVersion('maintenance/6.x')).toEqual([6])
    expect(releaseLineVersion('stable-2.1')).toEqual([2, 1])
    expect(releaseLineVersion('RELEASE/2.0')).toEqual([2, 0])
    expect(releaseLineVersion('lts/gallium')).toEqual([])
  })

  test('non-version digits under a release namespace never become a version', () => {
    expect(releaseLineVersion('release/fix-1234')).toEqual([])
  })

  test('everything else is not a release line', () => {
    expect(releaseLineVersion('main')).toBeNull()
    expect(releaseLineVersion('feature/login')).toBeNull()
    expect(releaseLineVersion('10')).toBeNull() // bare numbers are ticket ids
    expect(releaseLineVersion('12345')).toBeNull()
    expect(releaseLineVersion('11.x-hotfix')).toBeNull()
    expect(releaseLineVersion('release')).toBeNull() // a namespace needs a separator
    expect(releaseLineVersion('unrelated/2.3')).toBeNull()
  })
})

describe('compareReleaseVersions', () => {
  test('newer versions sort first', () => {
    expect(compareReleaseVersions([11], [10])).toBeLessThan(0)
    expect(compareReleaseVersions([2, 3], [2, 2])).toBeLessThan(0)
    expect(compareReleaseVersions([10], [11])).toBeGreaterThan(0)
  })

  test('more specific versions sort before their bare line', () => {
    expect(compareReleaseVersions([11, 0], [11])).toBeLessThan(0)
  })

  test('versionless lines sort last; equal versions tie', () => {
    expect(compareReleaseVersions([1], [])).toBeLessThan(0)
    expect(compareReleaseVersions([2, 3], [2, 3])).toBe(0)
  })
})
