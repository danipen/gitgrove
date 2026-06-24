// Blame: parse `git blame --porcelain` into one record per line, caching each
// commit's metadata (porcelain emits it only the first time a commit appears).

import type { BlameLine } from '@shared/types'
import { runGit } from './core'

/** Git's all-zero sha: blame's marker for an uncommitted working-tree line. */
const BLAME_ZERO_SHA = '0'.repeat(40)

/** Per-commit metadata shared by every line a commit introduced. */
interface BlameCommitInfo {
  authorName: string
  authorEmail: string
  date: string
  summary: string
  filename: string
  previous?: { hash: string; filename: string }
  isBoundary: boolean
}

/** Drop the surrounding angle brackets git wraps around the email field. */
const stripAngles = (s: string): string => s.replace(/^</, '').replace(/>$/, '')

/**
 * Unquote a git path. With `core.quotePath=false` git emits paths raw (UTF-8),
 * only wrapping in double quotes — with C-style escapes — when they contain a
 * quote, backslash, or control character; this reverses that rare case.
 */
function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p
  return p.slice(1, -1).replace(/\\(\\|"|t|n|r|[0-7]{1,3})/g, (_, esc: string) => {
    switch (esc) {
      case '\\':
        return '\\'
      case '"':
        return '"'
      case 't':
        return '\t'
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      default:
        return String.fromCharCode(Number.parseInt(esc, 8))
    }
  })
}

/**
 * Parse `git blame --porcelain` output into one record per line. Porcelain
 * is line-based (newline-delimited — `-z` does not NUL-delimit it), and emits
 * the full commit header only the *first* time a commit appears, then just an
 * abbreviated `<sha> <orig> <final>` header for later lines of that commit;
 * we cache each commit's metadata by sha so repeat lines reuse it (keeps large
 * files cheap). Every line ends with a tab-prefixed content line. Exported for
 * tests.
 */
export function parseBlamePorcelain(out: string): BlameLine[] {
  const lines = out.split('\n')
  const commits = new Map<string, BlameCommitInfo>()
  const result: BlameLine[] = []
  let i = 0
  while (i < lines.length) {
    // Header: "<40-hex sha> <orig-line> <final-line> [<lines-in-group>]".
    const m = lines[i].match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/)
    if (!m) {
      i++
      continue
    }
    const hash = m[1]
    const lineNumber = Number(m[2])
    i++

    // Extended header block — present only the first time this sha is seen.
    let info = commits.get(hash)
    if (!info) {
      const draft: Partial<BlameCommitInfo> = {}
      let isBoundary = false
      while (i < lines.length && !lines[i].startsWith('\t')) {
        const field = lines[i]
        if (field.startsWith('author ')) draft.authorName = field.slice(7)
        else if (field.startsWith('author-mail ')) draft.authorEmail = stripAngles(field.slice(12))
        else if (field.startsWith('author-time '))
          draft.date = new Date(Number(field.slice(12)) * 1000).toISOString()
        else if (field.startsWith('summary ')) draft.summary = field.slice(8)
        else if (field.startsWith('filename ')) draft.filename = unquoteGitPath(field.slice(9))
        else if (field.startsWith('previous ')) {
          const rest = field.slice(9)
          const sp = rest.indexOf(' ')
          draft.previous = { hash: rest.slice(0, sp), filename: unquoteGitPath(rest.slice(sp + 1)) }
        } else if (field === 'boundary') isBoundary = true
        i++
      }
      info = {
        authorName: draft.authorName ?? '',
        authorEmail: draft.authorEmail ?? '',
        date: draft.date ?? '',
        summary: draft.summary ?? '',
        filename: draft.filename ?? '',
        previous: draft.previous,
        isBoundary
      }
      commits.set(hash, info)
    }

    // The tab-prefixed content line closes the record.
    const content = lines[i]?.startsWith('\t') ? lines[i].slice(1) : ''
    i++

    result.push({
      hash,
      shortHash: hash.slice(0, 7),
      authorName: info.authorName,
      authorEmail: info.authorEmail,
      date: info.date,
      summary: info.summary,
      lineNumber,
      content,
      filename: info.filename,
      previous: info.previous,
      isBoundary: info.isBoundary || undefined,
      notCommitted: hash === BLAME_ZERO_SHA || undefined
    })
  }
  // git already emits final-file order; sort defensively so the gutter aligns.
  return result.sort((a, b) => a.lineNumber - b.lineNumber)
}

/**
 * Blame a file: each line annotated with the commit that last touched it.
 * No `ref` blames the working tree (uncommitted lines come back as git's
 * all-zero "Not Committed Yet" sha); a `ref` blames that revision. We force
 * `core.quotePath=false` so non-ASCII paths in the `filename`/`previous`
 * fields arrive raw rather than octal-escaped.
 */
export async function getBlame(repoPath: string, path: string, ref?: string): Promise<BlameLine[]> {
  const args = ['-c', 'core.quotePath=false', 'blame', '--porcelain']
  if (ref?.trim()) args.push(ref)
  args.push('--', path)
  return parseBlamePorcelain(await runGit(repoPath, args))
}
