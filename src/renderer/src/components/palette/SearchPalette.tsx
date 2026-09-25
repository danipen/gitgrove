// The command palette (Cmd/Ctrl+K): one box that searches everything —
// commands, branches, files, tags, stashes, worktrees, recent repositories and
// pasted commit ids. Enter reveals a result where it lives; Tab, right-click or
// the row's ⋯ open its full menu, so acting on something never requires
// navigating to it first. `>`, `@` and `/` narrow to commands, refs and files.
//
// The input keeps focus the whole time and owns the keyboard: arrows move the
// highlight through every section in order, Enter activates, Tab opens the
// highlighted row's menu (which then takes the keyboard until it closes).
// styles: styles/features/palette.css

import type { AppCommand } from '@shared/commands'
import { commandTitle } from '@shared/commands'
import type { ChangedFile, StashEntry } from '@shared/types'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { StashReviewDialog } from '@/components/changes/StashReviewDialog'
import type { BranchMenuContext } from '@/components/common/branchMenuItems'
import { ClearButton } from '@/components/common/ClearButton'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { Icon } from '@/lib/icons'
import { platform } from '@/lib/platform'
import type { BranchPrs } from '@/lib/pr-order'
import type { ResolvedTheme } from '@/lib/theme'
import { navTarget } from '@/lib/useListKeyNav'
import { PaletteRow } from './PaletteRow'
import { activateItem, closingFirst, itemMenu, type PaletteActions } from './paletteActions'
import { buildSections, type PaletteHit, type SectionId } from './paletteResults'
import { usePaletteSources } from './usePaletteSources'

/** Rows per PageUp/PageDown jump. */
const PAGE = 8

interface Props {
  open: boolean
  onClose: () => void
  /** The commands available right now (useAppCommands). */
  commands: () => AppCommand[]
  repoPath: string | null
  currentBranch: string | null
  changes: ChangedFile[]
  stashes: StashEntry[]
  githubWebUrl: string | null
  prByBranch: ReadonlyMap<string, BranchPrs>
  theme: ResolvedTheme
  actions: Omit<PaletteActions, 'reviewStash'>
}

/** One keyboard stop: a result, or a section's "N more" row. */
type Entry = { kind: 'hit'; hit: PaletteHit } | { kind: 'more'; section: SectionId }

export function SearchPalette(props: Props) {
  // The stash review outlives the palette: it opens as the palette closes.
  const [reviewing, setReviewing] = useState<StashEntry | null>(null)
  const { repoPath, actions, theme } = props
  return (
    <>
      {props.open && (
        <PaletteDialog {...props} actions={{ ...actions, reviewStash: setReviewing }} />
      )}
      {reviewing && repoPath && (
        <StashReviewDialog
          repoPath={repoPath}
          stash={reviewing}
          theme={theme}
          onApply={(pop) => {
            setReviewing(null)
            actions.runOp(() => window.gitgrove.stashApply(repoPath, reviewing.index, pop))
          }}
          onDrop={() => {
            setReviewing(null)
            actions.runOp(() => window.gitgrove.stashDrop(repoPath, reviewing.index))
          }}
          onClose={() => setReviewing(null)}
        />
      )}
    </>
  )
}

function PaletteDialog({
  onClose,
  commands,
  repoPath,
  currentBranch,
  changes,
  stashes,
  githubWebUrl,
  prByBranch,
  actions
}: Omit<Props, 'actions' | 'open' | 'theme'> & { actions: PaletteActions }) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<SectionId>>(() => new Set())
  const [index, setIndex] = useState(0)
  // The open row menu: at the cursor (right-click) or hung from a ⋯ (anchor).
  const [menu, setMenu] = useState<{
    key: string
    items: ContextMenuItem[]
    x: number
    y: number
    anchor?: DOMRect
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const loaded = usePaletteSources(repoPath, query)
  // The command list is fixed for the palette's lifetime (state can't change
  // underneath an open modal), so it's resolved once.
  const [commandList] = useState(() =>
    commands().map((command) => ({
      command,
      title: commandTitle(command.id, platform),
      accelerator: command.accelerator ?? null
    }))
  )

  const sections = useMemo(
    () =>
      buildSections(
        {
          commands: commandList,
          refs: loaded.refs,
          currentBranch,
          changes,
          fileMatches: loaded.fileMatches,
          filesLoading: loaded.filesLoading,
          stashes,
          worktrees: loaded.worktrees,
          repos: loaded.repos,
          currentRepoPath: repoPath,
          commit: loaded.commit
        },
        query,
        expanded
      ),
    // The loaded fields one by one: `loaded` itself is a fresh object every
    // render, and re-ranking 90k changed files on each hover would stutter.
    [
      commandList,
      loaded.refs,
      loaded.fileMatches,
      loaded.filesLoading,
      loaded.worktrees,
      loaded.repos,
      loaded.commit,
      currentBranch,
      changes,
      stashes,
      repoPath,
      query,
      expanded
    ]
  )

  const entries = useMemo(
    () =>
      sections.flatMap((section): Entry[] => [
        ...section.hits.map((hit): Entry => ({ kind: 'hit', hit })),
        ...(section.more > 0 ? [{ kind: 'more' as const, section: section.id }] : [])
      ]),
    [sections]
  )
  const selected = Math.min(index, Math.max(0, entries.length - 1))

  // A new query starts over: top result highlighted, sections collapsed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger.
  useEffect(() => {
    setIndex(0)
    setExpanded(new Set())
  }, [query])

  const scrollTo = (entry: number) =>
    listRef.current?.querySelector(`[data-entry="${entry}"]`)?.scrollIntoView({ block: 'nearest' })

  const branchContext: BranchMenuContext = {
    current: currentBranch,
    remote: (loaded.refs ?? []).filter((r) => r.kind === 'remote').map((r) => r.name),
    githubWebUrl,
    prByBranch
  }

  const activate = (entry: Entry | undefined) => {
    if (!entry) return
    if (entry.kind === 'more') {
      setExpanded((prev) => new Set(prev).add(entry.section))
      return
    }
    onClose()
    activateItem(entry.hit.item, actions)
  }

  const openMenu = (hit: PaletteHit, at: { x: number; y: number } | DOMRect) => {
    const items = itemMenu(hit.item, actions, branchContext)
    if (!items) return
    const place = at instanceof DOMRect ? { x: at.left, y: at.bottom, anchor: at } : at
    setMenu({ key: hit.key, items: closingFirst(items, onClose), ...place })
  }

  const closeMenu = () => {
    setMenu(null)
    inputRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      activate(entries[selected])
      return
    }
    if (e.key === 'Tab') {
      // Tab never leaves the palette; on a row with actions it opens them,
      // hung from the row's ⋯ like a click would.
      e.preventDefault()
      const entry = entries[selected]
      if (entry?.kind !== 'hit') return
      const row = listRef.current?.querySelector(`[data-entry="${selected}"]`)
      const anchor = row?.querySelector('.palette-row__more') ?? row
      if (anchor) openMenu(entry.hit, anchor.getBoundingClientRect())
      return
    }
    // Home/End stay with the input's caret; everything else navigates.
    if (e.key === 'Home' || e.key === 'End' || entries.length === 0) return
    const target = navTarget(e.key, selected, entries.length, PAGE)
    if (target === null) return
    e.preventDefault()
    setIndex(target)
    scrollTo(target)
  }

  const empty = sections.length === 0

  let entry = 0
  return (
    <>
      <div
        className="modal-backdrop palette-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div className="palette" role="dialog" aria-label="Search everything">
          <div className="palette__search">
            <Icon.Search size={16} />
            <input
              ref={inputRef}
              autoFocus
              spellCheck={false}
              placeholder={
                repoPath
                  ? 'Search commands, branches, files, tags…'
                  : 'Search commands and repositories…'
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded
              aria-controls="palette-results"
            />
            {query !== '' && <ClearButton label="Clear" onClear={() => setQuery('')} />}
          </div>
          <div className="palette__list" id="palette-results" role="listbox" ref={listRef}>
            {empty ? (
              <div className="popover__empty">
                {query.trim() ? 'Nothing matches' : 'Nothing to show yet'}
              </div>
            ) : (
              sections.map((section) => (
                <div key={section.id} className="palette__section" role="group">
                  <div className="palette__section-head">
                    {section.label}
                    {section.loading && <span className="spinner spinner--xs" />}
                  </div>
                  {section.hits.map((hit) => {
                    const at = entry++
                    return (
                      <PaletteRow
                        key={hit.key}
                        hit={hit}
                        entry={at}
                        selected={at === selected}
                        menuOpen={menu?.key === hit.key}
                        hasMenu={hit.item.kind !== 'command'}
                        onHover={() => at !== index && setIndex(at)}
                        onActivate={() => activate({ kind: 'hit', hit })}
                        onMenu={(pos) => openMenu(hit, pos)}
                      />
                    )
                  })}
                  {section.more > 0 &&
                    (() => {
                      const at = entry++
                      return (
                        <button
                          type="button"
                          tabIndex={-1}
                          data-entry={at}
                          className={`palette__more${at === selected ? ' is-kbd' : ''}`}
                          onMouseMove={() => at !== index && setIndex(at)}
                          onClick={() => activate({ kind: 'more', section: section.id })}
                        >
                          {section.more} more {section.label.toLowerCase()}
                        </button>
                      )
                    })()}
                </div>
              ))
            )}
          </div>
          <div className="palette__footer">
            <span>
              <kbd className="kbd">↑</kbd>
              <kbd className="kbd">↓</kbd> move
            </span>
            <span>
              <kbd className="kbd">↵</kbd> open
            </span>
            <span>
              <kbd className="kbd">⇥</kbd> actions
            </span>
            <span className="palette__scopes">
              <kbd className="kbd">&gt;</kbd> commands <kbd className="kbd">@</kbd> branches &amp;
              tags <kbd className="kbd">/</kbd> files
            </span>
          </div>
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          items={menu.items}
          onClose={closeMenu}
        />
      )}
    </>
  )
}
