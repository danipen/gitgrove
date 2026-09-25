// The command palette's result model: from everything it can search (commands,
// refs, files, stashes, worktrees, recent repos, a pasted commit id) and the
// typed query, the ranked sections it shows. Pure, so ranking, scoping and
// section limits are unit-tested without rendering anything.
//
// Every source is fuzzy-ranked with shared/fuzzy; files arrive pre-ranked
// from main (the full path list never crosses IPC) and are merged here with
// the working tree's changed files, which main's tracked-file index can't see
// when they're untracked.

import type { AppCommand } from '@shared/commands'
import { foldCase, fuzzyMatch, fuzzyMatchPath, normalizeQuery, TopMatches } from '@shared/fuzzy'
import type {
  ChangedFile,
  Commit,
  FileSearchMatch,
  RecentRepo,
  RefEntry,
  StashEntry,
  WorktreeInfo
} from '@shared/types'
import { stashLabel } from '@/lib/format'

export type PaletteItem =
  | { kind: 'command'; command: AppCommand; title: string; accelerator: string | null }
  | { kind: 'branch'; ref: RefEntry; current: boolean }
  | { kind: 'tag'; ref: RefEntry }
  /** A tracked or changed file; `change` is set when it has pending changes. */
  | { kind: 'file'; path: string; change: ChangedFile | null }
  | { kind: 'commit'; commit: Commit }
  | { kind: 'stash'; stash: StashEntry; label: string }
  /** Somewhere to open: a linked worktree or a recently opened repository. */
  | { kind: 'place'; place: 'worktree' | 'repo'; name: string; path: string }

export interface PaletteHit {
  key: string
  item: PaletteItem
  /** Matched character indexes per displayed field (see fieldsOf), for highlighting. */
  highlights: number[][]
}

export type SectionId =
  | 'commit'
  | 'commands'
  | 'branches'
  | 'files'
  | 'tags'
  | 'stashes'
  | 'worktrees'
  | 'repos'

export interface PaletteSection {
  id: SectionId
  label: string
  hits: PaletteHit[]
  /** Ranked hits held back until the section is expanded ("N more"). */
  more: number
  /** The source is still loading — the header shows a quiet spinner. */
  loading: boolean
}

/** Everything the palette searches. `null` = that source is still loading. */
export interface PaletteSources {
  commands: { command: AppCommand; title: string; accelerator: string | null }[]
  refs: RefEntry[] | null
  currentBranch: string | null
  changes: ChangedFile[]
  /** Main's ranked tracked-file matches for the latest answered query. */
  fileMatches: FileSearchMatch[]
  /** A file search for the current query is still running. */
  filesLoading: boolean
  stashes: StashEntry[]
  worktrees: WorktreeInfo[] | null
  repos: RecentRepo[] | null
  currentRepoPath: string | null
  /** The commit a pasted id resolved to, if any. */
  commit: Commit | null
}

/** A leading character narrows the search to one kind of thing. */
export type Scope = 'all' | 'commands' | 'refs' | 'files'

const SCOPE_PREFIXES: Record<string, Scope> = { '>': 'commands', '@': 'refs', '/': 'files' }

export function parseScope(query: string): { scope: Scope; text: string } {
  const trimmed = query.trimStart()
  const scope = SCOPE_PREFIXES[trimmed[0]]
  return scope ? { scope, text: trimmed.slice(1) } : { scope: 'all', text: query }
}

/** What a pasted commit id looks like: 7+ hex digits (git's default abbrev). */
export function looksLikeCommitId(text: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(text.trim())
}

/** Rows a section shows before "N more". */
export const COLLAPSED_ROWS = 5
/** Rows an expanded section shows (and what file search asks main for). */
export const EXPANDED_ROWS = 50

const SECTION_ORDER: { id: SectionId; label: string; scopes: Scope[] }[] = [
  { id: 'commit', label: 'Commit', scopes: ['all'] },
  { id: 'commands', label: 'Commands', scopes: ['all', 'commands'] },
  { id: 'branches', label: 'Branches', scopes: ['all', 'refs'] },
  { id: 'files', label: 'Files', scopes: ['all', 'files'] },
  { id: 'tags', label: 'Tags', scopes: ['all', 'refs'] },
  { id: 'stashes', label: 'Stashes', scopes: ['all'] },
  { id: 'worktrees', label: 'Worktrees', scopes: ['all'] },
  { id: 'repos', label: 'Repositories', scopes: ['all'] }
]

/** One searchable, displayed field of an item. */
interface Field {
  text: string
  /** Match as a path (file-name first) rather than free text. */
  path?: boolean
}

/** The fields each item kind is searched — and highlighted — by. */
export function fieldsOf(item: PaletteItem): Field[] {
  switch (item.kind) {
    case 'command':
      return [{ text: item.title }]
    case 'branch':
    case 'tag':
      return [{ text: item.ref.name }]
    case 'file':
      return [{ text: item.path, path: true }]
    case 'commit':
      return [{ text: item.commit.shortHash }]
    case 'stash':
      return [{ text: item.label }]
    case 'place':
      return [{ text: item.name }, { text: item.path, path: true }]
  }
}

function hitKey(item: PaletteItem): string {
  switch (item.kind) {
    case 'command':
      return `command:${item.command.id}`
    case 'branch':
    case 'tag':
      return `${item.kind}:${item.ref.kind}:${item.ref.name}`
    case 'file':
      return `file:${item.path}`
    case 'commit':
      return `commit:${item.commit.hash}`
    case 'stash':
      return `stash:${item.stash.sha}`
    case 'place':
      return `${item.place}:${item.path}`
  }
}

const unmatched = (item: PaletteItem): PaletteHit => ({
  key: hitKey(item),
  item,
  highlights: fieldsOf(item).map(() => [])
})

/** Score an item on its best field; every field that matched gets highlighted. */
function matchItem(needle: string, item: PaletteItem): { hit: PaletteHit; score: number } | null {
  let best: number | null = null
  const highlights = fieldsOf(item).map((field) => {
    const folded = foldCase(field.text)
    const match = field.path
      ? fuzzyMatchPath(needle, field.text, folded)
      : fuzzyMatch(needle, field.text, folded)
    if (!match) return []
    if (best === null || match.score > best) best = match.score
    return match.positions
  })
  return best === null ? null : { hit: { key: hitKey(item), item, highlights }, score: best }
}

/** The best EXPANDED_ROWS items for `needle`, best first — or all of them, in
 *  source order, for an empty query. */
function rank(needle: string, items: PaletteItem[]): PaletteHit[] {
  if (needle.length === 0) return items.slice(0, EXPANDED_ROWS).map(unmatched)
  const top = new TopMatches<PaletteHit>(EXPANDED_ROWS)
  for (const item of items) {
    const match = matchItem(needle, item)
    if (match) top.add(match.hit, match.score, fieldsOf(item)[0].text.length)
  }
  return top.items()
}

/**
 * Files: the working tree's changes ranked here, merged with main's ranked
 * tracked files (whose scores come from the same matcher, so they compare).
 * A changed file appears once, carrying its change. An empty query lists the
 * changes alone — "what am I working on".
 */
function rankFiles(needle: string, sources: PaletteSources): PaletteHit[] {
  const changes = sources.changes.map(
    (change): PaletteItem => ({ kind: 'file', path: change.path, change })
  )
  if (needle.length === 0) return rank(needle, changes)
  const top = new TopMatches<PaletteHit>(EXPANDED_ROWS)
  const changed = new Set<string>()
  for (const item of changes) {
    const match = matchItem(needle, item)
    if (item.kind === 'file') changed.add(item.path)
    if (match) top.add(match.hit, match.score, fieldsOf(item)[0].text.length)
  }
  for (const file of sources.fileMatches) {
    if (changed.has(file.path)) continue
    const item: PaletteItem = { kind: 'file', path: file.path, change: null }
    top.add({ key: hitKey(item), item, highlights: [file.positions] }, file.score, file.path.length)
  }
  return top.items()
}

function sectionHits(id: SectionId, needle: string, sources: PaletteSources): PaletteHit[] {
  const refs = sources.refs ?? []
  switch (id) {
    case 'commit': {
      const commit = sources.commit
      if (!commit || !looksLikeCommitId(needle) || !commit.hash.startsWith(needle)) return []
      const shown = Math.min(needle.length, commit.shortHash.length)
      const item: PaletteItem = { kind: 'commit', commit }
      return [{ key: hitKey(item), item, highlights: [[...Array(shown).keys()]] }]
    }
    case 'commands':
      return rank(
        needle,
        sources.commands.map((c): PaletteItem => ({ kind: 'command', ...c }))
      )
    case 'branches': {
      // Unfiltered, the list is "where you've been working": local branches,
      // the checked-out one first, then by recency (refs arrive newest first).
      const branches = refs.filter(
        (r) => r.kind !== 'tag' && (needle.length > 0 || r.kind === 'local')
      )
      const items = branches.map(
        (ref): PaletteItem => ({
          kind: 'branch',
          ref,
          current: ref.kind === 'local' && ref.name === sources.currentBranch
        })
      )
      if (needle.length === 0) items.sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)))
      return rank(needle, items)
    }
    case 'files':
      return rankFiles(needle, sources)
    case 'tags':
      // Tags pile up by the thousand; they only show once you search.
      if (needle.length === 0) return []
      return rank(
        needle,
        refs.filter((r) => r.kind === 'tag').map((ref): PaletteItem => ({ kind: 'tag', ref }))
      )
    case 'stashes':
      return rank(
        needle,
        sources.stashes.map(
          (stash): PaletteItem => ({ kind: 'stash', stash, label: stashLabel(stash) })
        )
      )
    case 'worktrees':
      return rank(
        needle,
        (sources.worktrees ?? [])
          .filter((w) => !w.isCurrent)
          .map(
            (w): PaletteItem => ({
              kind: 'place',
              place: 'worktree',
              name: w.branch ?? `detached @ ${w.headShort}`,
              path: w.path
            })
          )
      )
    case 'repos':
      return rank(
        needle,
        (sources.repos ?? [])
          // A vanished folder can't be opened from here (the switcher's
          // recovery flow handles it).
          .filter((r) => r.path !== sources.currentRepoPath && !r.missing)
          .map((r): PaletteItem => ({ kind: 'place', place: 'repo', name: r.name, path: r.path }))
      )
  }
}

const isCurrent = (item: PaletteItem) => item.kind === 'branch' && item.current

function sectionLoading(id: SectionId, needle: string, sources: PaletteSources): boolean {
  switch (id) {
    case 'branches':
    case 'tags':
      return sources.refs === null
    case 'files':
      return needle.length > 0 && sources.filesLoading
    case 'worktrees':
      return sources.worktrees === null
    case 'repos':
      return sources.repos === null
    default:
      return false
  }
}

/**
 * The sections to show for `query`, in a fixed order (so each kind of thing
 * is always in the same place), each ranked, capped at COLLAPSED_ROWS unless
 * `expanded`. Empty sections drop out — unless still loading, so the spinner
 * says more may be coming.
 */
export function buildSections(
  sources: PaletteSources,
  query: string,
  expanded: ReadonlySet<SectionId>
): PaletteSection[] {
  const { scope, text } = parseScope(query)
  const needle = normalizeQuery(text)
  const sections: PaletteSection[] = []
  for (const { id, label, scopes } of SECTION_ORDER) {
    if (!scopes.includes(scope)) continue
    const all = sectionHits(id, needle, sources)
    const loading = sectionLoading(id, needle, sources)
    if (all.length === 0 && !loading) continue
    const shown = expanded.has(id) ? all : all.slice(0, COLLAPSED_ROWS)
    sections.push({ id, label, hits: shown, more: all.length - shown.length, loading })
  }
  return sections
}
