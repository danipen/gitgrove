// The Graph tab: Plastic-style 2D branch explorer. Composes the data feed
// (useGraphLog), the pure layout (layout.ts), the canvas (GraphCanvas) and the
// filter bar (GraphToolbar); owns filter/search state and the context menus.
// Commit selection and the diff pane live in App — the graph only reports
// "this commit was picked".
// styles: styles/features/graph.css

import type { BranchInfo, Commit } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import type { BranchAction } from '@/components/toolbar/BranchSwitcher'
import { filterTerms } from '@/lib/commitFilter'
import { Icon } from '@/lib/icons'
import { usePersistentState } from '@/lib/persist'
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas'
import { type AuthorOption, DATE_PRESETS, type DatePresetId, GraphToolbar } from './GraphToolbar'
import { collectBranchNames, type GraphNode, type GraphRow, layoutGraph } from './layout'
import { linkableChains, twinHashes } from './links'
import { relatedBranches } from './related'
import { releaseLineVersion, releaseVersionWithOverride } from './releases'
import { useBackportLinks } from './useBackportLinks'
import { useGraphLog } from './useGraphLog'

interface Props {
  repoPath: string
  /** True while the Graph tab is visible (data loads lazily on first visit). */
  active: boolean
  /** Bumped by App's refresh so the graph follows watcher/post-op updates. */
  refreshNonce: number
  theme: 'dark' | 'light'
  branch: BranchInfo | null
  remotes: string[]
  /** Uncommitted change count — the dashed WIP node on the HEAD row. */
  changesCount: number
  selectedCommit: Commit | null
  onSelectCommit: (commit: Commit | null) => void
  /** Tip of the branch whose changes view is open, or null. */
  selectedBranchTip: string | null
  /** A branch label was clicked — open its whole-branch changes view. */
  onSelectBranch: (row: GraphRow) => void
  /** Right-click menu for a commit node — the same one History uses. */
  commitMenuFor: (commit: Commit) => ContextMenuItem[]
  onCheckoutBranch: (name: string) => void
  onBranchAction: (action: BranchAction, name: string) => void
  /** WIP node clicked — take the user to their uncommitted changes. */
  onOpenChanges: () => void
  onError: (e: unknown) => void
}

export function GraphView({
  repoPath,
  active,
  refreshNonce,
  theme,
  branch,
  remotes,
  changesCount,
  selectedCommit,
  onSelectCommit,
  selectedBranchTip,
  onSelectBranch,
  commitMenuFor,
  onCheckoutBranch,
  onBranchAction,
  onOpenChanges,
  onError
}: Props) {
  const [branchFilter, setBranchFilter] = useState<Set<string> | null>(null)
  /** The Focus lens: seed branch + hop depth. Focus populates branchFilter
   *  with the seed's related set, so the Branches picker can fine-tune it. */
  const [focus, setFocus] = useState<{ name: string; hops: number } | null>(null)
  // "Pin as Release Line" overrides, kept per repo under one storage key.
  const [releasePins, setReleasePins] = usePersistentState<Record<string, Record<string, boolean>>>(
    'gg.graphReleasePins',
    {}
  )
  const [authorFilter, setAuthorFilter] = useState<Set<string> | null>(null)
  const [datePreset, setDatePreset] = useState<DatePresetId>('all')
  // View shaping (persisted): what makes busy trunk-based repos readable.
  const [structureOnly, setStructureOnly] = usePersistentState('gg.graphStructureOnly', false)
  const [hideMerged, setHideMerged] = usePersistentState('gg.graphHideMerged', false)
  /** Backport twins stay on unless hidden: phrased as a hide-option (like
   *  hideMerged) so the popover's default state is all-unchecked and the View
   *  chip only counts real changes — never an opt-in, or nobody finds it. */
  const [hideTwins, setHideTwins] = usePersistentState('gg.graphHideTwins', false)
  const [search, setSearch] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const controls = useRef<GraphCanvasHandle | null>(null)

  // A different repo is a fresh view: focus and the branch filter both name
  // branches of the previous repo and must never leak across.
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoPath is the intentional trigger
  useEffect(() => {
    setFocus(null)
    setBranchFilter(null)
  }, [repoPath])

  const since = DATE_PRESETS.find((p) => p.id === datePreset)?.since ?? null
  const { commits, loading, loaded, limitHit, showMore } = useGraphLog({
    repoPath,
    active,
    refreshNonce,
    since,
    fail: onError
  })

  const releaseOverrides = useMemo(() => {
    const pins = releasePins[repoPath]
    return pins && Object.keys(pins).length > 0 ? new Map(Object.entries(pins)) : null
  }, [releasePins, repoPath])

  const input = useMemo(
    () => ({
      commits,
      remotes,
      headBranch: branch && !branch.detached ? branch.current : '',
      detached: branch?.detached ?? false,
      defaultBranch: branch?.defaultBranch ?? null,
      releaseOverrides
    }),
    [commits, remotes, branch, releaseOverrides]
  )
  const branches = useMemo(() => collectBranchNames(input), [input])
  const layout = useMemo(
    () => layoutGraph({ ...input, visibleBranches: branchFilter, hideMerged, structureOnly }),
    [input, branchFilter, hideMerged, structureOnly]
  )

  // Backport twins: only the mainline + release-line chains enter the
  // patch-id pipeline — a repo without release lines pays nothing. An empty
  // set (opted out) short-circuits the pipeline entirely.
  const linkable = useMemo(() => {
    if (hideTwins) return new Set<number>()
    return linkableChains(layout.rows, input.defaultBranch, releaseOverrides)
  }, [hideTwins, layout, input, releaseOverrides])
  const links = useBackportLinks(repoPath, layout, linkable)

  const authors = useMemo((): AuthorOption[] => {
    const byEmail = new Map<string, AuthorOption>()
    for (const commit of commits) {
      const email = commit.authorEmail.toLowerCase()
      const entry = byEmail.get(email)
      if (entry) entry.commits++
      else byEmail.set(email, { name: commit.authorName, email, commits: 1 })
    }
    return [...byEmail.values()].sort((a, b) => b.commits - a.commits)
  }, [commits])

  // Search terms + author filter dim everything they don't match. Hits are
  // ordered newest-first for Enter/arrow navigation between them.
  const searching = filterTerms(search).length > 0
  const matchList = useMemo((): string[] | null => {
    const terms = filterTerms(search)
    if (terms.length === 0 && authorFilter === null) return null
    const hits: string[] = []
    for (let i = layout.nodes.length - 1; i >= 0; i--) {
      const c = layout.nodes[i].commit
      if (authorFilter && !authorFilter.has(c.authorEmail.toLowerCase())) continue
      if (terms.length > 0) {
        const hay = `${c.subject} ${c.authorName} ${c.hash}`.toLowerCase()
        if (!terms.every((t) => hay.includes(t))) continue
      }
      hits.push(c.hash)
    }
    return hits
  }, [layout, search, authorFilter])
  const matches = useMemo(() => (matchList ? new Set(matchList) : null), [matchList])
  const matchCount = searching ? (matchList?.length ?? 0) : 0
  const activeMatch =
    searching && matchList && matchList.length > 0
      ? matchList[((matchIndex % matchList.length) + matchList.length) % matchList.length]
      : null

  // New search → restart at the newest hit and bring it into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query change is the intentional trigger
  useEffect(() => setMatchIndex(0), [search])
  useEffect(() => {
    if (activeMatch) controls.current?.reveal(activeMatch)
  }, [activeMatch])

  const stepMatch = (dir: 1 | -1) => {
    if (!matchList || matchList.length === 0) return
    setMatchIndex((i) => i + dir)
  }

  // Focus: one gesture to a subproject. The related set is computed on an
  // unfiltered, unshaped layout (focus must see through the current filters)
  // and becomes the branch filter, so all filter machinery just works.
  const focusOn = (name: string, hops: number) => {
    setFocus({ name, hops })
    setBranchFilter(relatedBranches(layoutGraph(input), name, hops))
  }
  const exitFocus = () => {
    setFocus(null)
    setBranchFilter(null)
  }

  // Esc exits focus — but a selected commit wins the first press (deselect),
  // and inputs (search, pickers) keep their own Escape behaviour.
  useEffect(() => {
    if (!focus) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (selectedCommit) {
        onSelectCommit(null)
        return
      }
      setFocus(null)
      setBranchFilter(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus, selectedCommit, onSelectCommit])

  // Store only disagreements with the name heuristic, so the map stays tiny
  // and detection keeps working for every branch the user never touched.
  const toggleReleasePin = (name: string, pin: boolean) => {
    const pins = { ...(releasePins[repoPath] ?? {}) }
    if (pin === (releaseLineVersion(name) !== null)) delete pins[name]
    else pins[name] = pin
    setReleasePins({ ...releasePins, [repoPath]: pins })
  }

  // "Go to Twin": jump to the same change on another line. One item per
  // twin — usually one; a chain across 12 → 11.x → 10.x gets two.
  const openNodeMenu = (node: GraphNode, x: number, y: number) => {
    const twinItems: ContextMenuItem[] = twinHashes(links, node.commit.hash).flatMap((hash) => {
      const twin = layout.nodeByHash.get(hash)
      if (!twin) return []
      const branch = layout.rows.find((r) => r.chain === twin.chain)
      return [
        {
          label: `Go to Twin on ${branch?.name ?? twin.commit.shortHash}`,
          icon: <Icon.CherryPick size={15} />,
          onClick: () => {
            onSelectCommit(twin.commit)
            controls.current?.reveal(twin.commit.hash)
          }
        }
      ]
    })
    const items = commitMenuFor(node.commit)
    setMenu({ x, y, items: twinItems.length > 0 ? [...twinItems, {}, ...items] : items })
  }

  const openRowMenu = (row: GraphRow, x: number, y: number) => {
    const changesItem: ContextMenuItem = {
      label: 'View Branch Changes',
      icon: <Icon.Diff size={15} />,
      onClick: () => onSelectBranch(row)
    }
    if (row.kind === 'unnamed' || row.kind === 'detached') {
      // No branch ref to act on — but the whole-branch diff still applies.
      setMenu({ x, y, items: [changesItem] })
      return
    }
    const isCurrent = !branch?.detached && branch?.current === row.name
    const current = branch?.current ?? 'current branch'
    const isRelease = releaseVersionWithOverride(row.name, releaseOverrides?.get(row.name)) !== null
    const items: ContextMenuItem[] = [
      changesItem,
      {
        label: `Focus on ${row.name}`,
        icon: <Icon.Focus size={15} />,
        onClick: () => focusOn(row.name, focus?.hops ?? 1)
      },
      {},
      {
        label: `Checkout ${row.name}`,
        icon: <Icon.Branch size={15} />,
        disabled: isCurrent,
        onClick: () => onCheckoutBranch(row.name)
      },
      {},
      {
        label: `Merge ${row.name} into ${current}…`,
        icon: <Icon.Merge size={15} />,
        disabled: isCurrent,
        onClick: () => onBranchAction('merge', row.name)
      },
      ...(row.kind === 'branch'
        ? [
            {},
            {
              label: 'Rename Branch…',
              icon: <Icon.Pencil size={15} />,
              onClick: () => onBranchAction('rename', row.name)
            },
            {
              label: 'Delete Branch…',
              icon: <Icon.Trash size={15} />,
              danger: true,
              disabled: isCurrent,
              onClick: () => onBranchAction('delete', row.name)
            }
          ]
        : []),
      {},
      {
        // Pinned release lines stack right under the mainline (layout.ts).
        label: isRelease ? 'Unpin Release Line' : 'Pin as Release Line',
        icon: <Icon.Tag size={15} />,
        onClick: () => toggleReleasePin(row.name, !isRelease)
      },
      {
        label: 'Copy Branch Name',
        icon: <Icon.Copy size={15} />,
        onClick: () => window.gitgrove.clipboardWrite(row.name)
      }
    ]
    setMenu({ x, y, items })
  }

  const empty = loaded && commits.length === 0
  const filteredOut = loaded && commits.length > 0 && layout.nodes.length === 0

  return (
    <div className="graph-view">
      <GraphToolbar
        branches={branches}
        branchFilter={branchFilter}
        onBranchFilter={setBranchFilter}
        authors={authors}
        authorFilter={authorFilter}
        onAuthorFilter={setAuthorFilter}
        datePreset={datePreset}
        onDatePreset={setDatePreset}
        structureOnly={structureOnly}
        onStructureOnly={setStructureOnly}
        hideMerged={hideMerged}
        onHideMerged={setHideMerged}
        hideTwins={hideTwins}
        onHideTwins={setHideTwins}
        focus={focus}
        onFocusHops={(hops) => focus && focusOn(focus.name, hops)}
        onExitFocus={exitFocus}
        search={search}
        onSearch={setSearch}
        matchCount={matchCount}
        matchIndex={activeMatch && matchList ? matchList.indexOf(activeMatch) : -1}
        onMatchStep={stepMatch}
      />
      <div className="graph-stage">
        {!loaded && loading ? (
          <div className="center-state">
            <div className="spinner" />
          </div>
        ) : empty ? (
          <div className="center-state">
            <div className="icon-ring">
              <Icon.Branch size={22} />
            </div>
            <h3>No history</h3>
            <p>This repository doesn’t have any commits yet.</p>
          </div>
        ) : filteredOut ? (
          <div className="center-state">
            <h3>Nothing to show</h3>
            <p>No branches match the current filters.</p>
            <button type="button" className="btn-ghost" onClick={exitFocus}>
              Show all branches
            </button>
          </div>
        ) : (
          <GraphCanvas
            layout={layout}
            theme={theme}
            selectedHash={selectedCommit?.hash ?? null}
            selectedBranchTip={selectedBranchTip}
            matches={matches}
            activeMatch={activeMatch}
            changesCount={changesCount}
            links={links}
            controls={controls}
            onSelectNode={(node) => onSelectCommit(node ? node.commit : null)}
            onNodeMenu={openNodeMenu}
            onRowClick={onSelectBranch}
            onRowMenu={openRowMenu}
            onRowDoubleClick={(row) => {
              const isCurrent = !branch?.detached && branch?.current === row.name
              if (!isCurrent && row.kind !== 'unnamed' && row.kind !== 'detached') {
                onCheckoutBranch(row.name)
              }
            }}
            onWipClick={onOpenChanges}
          />
        )}
        {loaded && layout.nodes.length > 0 && (
          <div className="graph-nav">
            <button
              type="button"
              className="icon-btn"
              aria-label="Go to home changeset"
              data-tip="Go to home changeset (Home)"
              onClick={() => controls.current?.jumpToHead()}
            >
              <Icon.Home size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Fit diagram"
              data-tip="Fit diagram (0)"
              onClick={() => controls.current?.fit()}
            >
              <Icon.Fit size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Zoom in"
              data-tip="Zoom in (+)"
              onClick={() => controls.current?.zoomIn()}
            >
              <Icon.ZoomIn size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Zoom out"
              data-tip="Zoom out (−)"
              onClick={() => controls.current?.zoomOut()}
            >
              <Icon.ZoomOut size={15} />
            </button>
          </div>
        )}
        <div className="graph-notices">
          {limitHit && !empty && (
            <div className="graph-more">
              Showing the latest {commits.length.toLocaleString()} commits
              <button
                type="button"
                className="btn-ghost btn-ghost--sm"
                disabled={loading}
                onClick={showMore}
              >
                {loading ? 'Loading…' : 'Show more'}
              </button>
            </div>
          )}
        </div>
        {loading && loaded && <div className="graph-refresh spinner spinner--sm" />}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
