// Appending patterns to the repo's .gitignore.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { enqueue } from '../exec'

/**
 * Merge gitignore pattern lines into existing `.gitignore` content: appended
 * at the end, skipping lines already present (compared trimmed of trailing
 * whitespace, which gitignore itself ignores unless escaped). Returns the new
 * content, or null when every pattern is already covered — the caller then
 * leaves the file untouched so the watcher sees no phantom change.
 * Pure + exported for tests.
 */
export function appendIgnoreEntries(existing: string, patterns: string[]): string | null {
  const present = new Set(existing.split('\n').map((l) => l.replace(/\s+$/, '')))
  const missing = patterns.filter((p) => !present.has(p))
  if (missing.length === 0) return null
  const lines = `${missing.join('\n')}\n`
  if (existing === '') return lines
  // Preserve the existing content byte-for-byte; only mend a missing final
  // newline so our first pattern doesn't glue onto the last existing line.
  return existing.endsWith('\n') ? existing + lines : `${existing}\n${lines}`
}

/**
 * Append patterns to the repo root's `.gitignore`, creating it if missing.
 * Plain file I/O, but it rides the write queue: a concurrent checkout or
 * stash could otherwise rewrite `.gitignore` under us and lose the edit.
 */
export async function ignorePatterns(repoPath: string, patterns: string[]): Promise<void> {
  if (patterns.length === 0) return
  await enqueue(repoPath, async () => {
    const file = join(repoPath, '.gitignore')
    const existing = await readFile(file, 'utf8').catch(() => '')
    const updated = appendIgnoreEntries(existing, patterns)
    if (updated !== null) await writeFile(file, updated, 'utf8')
  })
}
