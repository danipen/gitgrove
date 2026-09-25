import { describe, expect, test } from 'bun:test'
import type { ChangedFile } from '@shared/types'

// The builder reads `window.gitgrove` (platform at module load, revealFile on
// click); tests run without a DOM, so stub the minimal bridge first and import
// dynamically (a static import would be hoisted above the stub).
const revealed: [string, string][] = []
;(globalThis as { window?: unknown }).window = {
  gitgrove: {
    platform: 'darwin',
    revealFile: async (repoPath: string, path: string) => {
      revealed.push([repoPath, path])
    }
  }
}
const { revealFileItem } = await import('./revealFileItem')

const file = (status: ChangedFile['status']): ChangedFile => ({
  path: 'src/app.ts',
  status,
  staged: false
})

describe('revealFileItem', () => {
  test('uses the platform-native label', () => {
    expect(revealFileItem(file('modified'), '/repo').label).toBe('Reveal in Finder')
  })

  test('reveals the file by its repo-relative path', () => {
    revealFileItem(file('untracked'), '/repo').onClick?.()
    expect(revealed).toEqual([['/repo', 'src/app.ts']])
  })

  test('is enabled for files on disk, disabled for a deleted change', () => {
    expect(revealFileItem(file('modified'), '/repo').disabled).toBe(false)
    expect(revealFileItem(file('untracked'), '/repo').disabled).toBe(false)
    expect(revealFileItem(file('deleted'), '/repo').disabled).toBe(true)
  })
})
