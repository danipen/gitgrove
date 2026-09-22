// The Graph tab's sidebar pane: what the current selection changed. Two
// selection shapes share it — a single commit (node click) and a whole branch
// (label click: everything between the branch's base and its tip). Clicking a
// file drives the shared diff pane under the diagram — the History tab's
// files panel, arranged for the graph's sidebar.
// styles: styles/features/graph.css

import type { ChangedFile, Commit, PullRequestInfo } from '@shared/types'
import { useEffect } from 'react'
import { useAiExplainCommit } from '@/components/common/AiExplainCommit'
import { copyPathItems } from '@/components/common/copyPathItems'
import { useFileFilter } from '@/components/common/FileFilter'
import { type FileHistoryMode, fileHistoryItems } from '@/components/common/fileHistoryItems'
import { PrRow } from '@/components/common/PrHoverCard'
import { WorkingFileList } from '@/components/common/WorkingFileList'
import { AvatarStack } from '@/components/history/AvatarStack'
import {
  CommitBody,
  CommitMeta,
  CommitRefs,
  CopyButton,
  DiffStat
} from '@/components/history/CommitSummary'
import { coAuthorsOf } from '@/lib/coauthors'
import { pluralize } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { BranchPrs } from '@/lib/pr-order'
import { useSpinDelay } from '@/lib/useSpinDelay'
import { landedPrOf } from './landedPr'
import type { GraphRow } from './layout'
import { landedPrInfo } from './rowPrs'
import type { BranchRange } from './useBranchRange'

interface Props {
  repoPath: string
  /** The selected commit — shown when no branch range is open. */
  commit: Commit | null
  /** The open branch-changes selection; wins over `commit` when set. */
  range: BranchRange | null
  /** Branches squash-merged into the selected commit (the diagram draws them
   *  as plain merges — this is where the squash gets named). */
  squashedBranches: readonly GraphRow[]
  /** Open a branch's whole-branch changes view. */
  onSelectBranch: (row: GraphRow) => void
  /** The open branch's PRs (its label chip's), when it has any. */
  branchPrs: BranchPrs | undefined
  /** The repo's GitHub web base, or null off GitHub (no PR links). */
  githubWebUrl: string | null
  files: ChangedFile[]
  filesLoading: boolean
  selectedFilePath: string | null
  onSelectFile: (path: string) => void
  onFileSelectionChange?: (count: number) => void
  onOpenFileHistory: (path: string, mode: FileHistoryMode, baseRef: string | null) => void
  /** Open Settings → AI (the ✨ Explain teaser's one button). */
  onSetupAi: () => void
}

// The shared commit grammar (see CommitSummary.tsx): subject → CommitMeta →
// CommitBody → CommitRefs, arranged for the narrow sidebar.
function CommitHead({
  commit,
  repoPath,
  squashedBranches,
  onSelectBranch,
  githubWebUrl,
  onSetupAi
}: {
  commit: Commit
  repoPath: string
  squashedBranches: readonly GraphRow[]
  onSelectBranch: (row: GraphRow) => void
  githubWebUrl: string | null
  onSetupAi: () => void
}) {
  const explain = useAiExplainCommit({ repoPath, hash: commit.hash, onSetupAi })
  // A commit that landed a PR links to it — one click from the graph to the
  // review conversation that produced it.
  const landed = githubWebUrl ? landedPrOf(commit) : null
  return (
    <div className="graph-detail__head">
      <div className="graph-detail__title">
        <AvatarStack
          author={{ name: commit.authorName, email: commit.authorEmail }}
          coAuthors={coAuthorsOf(commit)}
          size={28}
        />
        <div className="graph-detail__subject" data-tip={commit.subject} data-tip-overflow="">
          {commit.subject}
        </div>
      </div>
      <CommitMeta commit={commit} extra={explain.trigger} />
      <SquashNote branches={squashedBranches} onSelectBranch={onSelectBranch} />
      {/* Compact: the commit's own subject and body already carry the title. */}
      {landed && githubWebUrl && <PrList prs={[landedPrInfo(landed, '', githubWebUrl)]} compact />}
      {/* Keyed by hash: switching commits remounts the body, resetting its
          collapse state and re-probing overflow (see CommitBody). */}
      <CommitBody key={commit.hash} commit={commit} />
      {explain.card}
      <CommitRefs key={`refs-${commit.hash}`} commit={commit} />
    </div>
  )
}

/** "Squash of <branch>": the landing commit carries a whole branch, merged by
 *  content — no ancestry joins them, so `git log` won't list the branch's
 *  commits here. Each name opens that branch's changes. */
function SquashNote({
  branches,
  onSelectBranch
}: {
  branches: readonly GraphRow[]
  onSelectBranch: (row: GraphRow) => void
}) {
  if (branches.length === 0) return null
  return (
    <div className="graph-detail__squash">
      <Icon.Branch size={12} />
      <span>Squash of</span>
      {branches.map((row) => (
        <button
          key={`${row.name}:${row.tipHash}`}
          type="button"
          className="graph-detail__squash-branch"
          data-tip="Show everything this branch changed"
          onClick={() => onSelectBranch(row)}
        >
          {row.name}
        </button>
      ))}
    </div>
  )
}

/** A branch's (or a landing commit's) pull requests as link rows — the PR
 *  hovercard's rows, laid into the pane. */
function PrList({ prs, compact }: { prs: readonly PullRequestInfo[]; compact?: boolean }) {
  return (
    <div className="graph-detail__prs">
      {prs.map((pr) => (
        <PrRow key={pr.number} pr={pr} compact={compact} />
      ))}
    </div>
  )
}

function RangeHead({ range, prs }: { range: BranchRange; prs: BranchPrs | undefined }) {
  return (
    <div className="graph-detail__head">
      <div className="graph-detail__title">
        <span className="graph-detail__branch-icon">
          <Icon.Branch size={16} />
        </span>
        <div className="graph-detail__subject" data-tip={range.name} data-tip-overflow="">
          {range.name}
        </div>
      </div>
      <div className="graph-detail__meta">
        <span>
          {range.base
            ? 'Everything this branch changed since it split off'
            : 'Everything on this branch (it starts at a root commit)'}
        </span>
        {range.base && (
          <span className="commit-summary__sha">
            <span className="commit__hash">{range.base.slice(0, 7)}</span>
            <CopyButton value={range.base} label="Copy base SHA" />
          </span>
        )}
      </div>
      {prs && <PrList prs={prs.prs} />}
    </div>
  )
}

export function GraphDetailPane({
  repoPath,
  commit,
  range,
  squashedBranches,
  onSelectBranch,
  branchPrs,
  githubWebUrl,
  files,
  filesLoading,
  selectedFilePath,
  onSelectFile,
  onFileSelectionChange,
  onOpenFileHistory,
  onSetupAi
}: Props) {
  const filesSpin = useSpinDelay(filesLoading)
  const {
    filtered: visibleFiles,
    query: filterQuery,
    active: filterActive,
    bar: filterBar,
    reset: resetFilter
  } = useFileFilter(files, ['added', 'modified', 'deleted', 'renamed'])
  // A new selection (commit or branch) starts with a clean file filter.
  const selectionKey = range ? `${range.base}..${range.head}` : (commit?.hash ?? '')
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection switch is the intentional trigger
  useEffect(() => resetFilter(), [selectionKey])

  if (!range && !commit) {
    return (
      <div className="center-state">
        <div className="icon-ring">
          <Icon.Branch size={22} />
        </div>
        <h3>Branch explorer</h3>
        <p>Click a commit for its changes, or a branch label for everything the branch did.</p>
      </div>
    )
  }

  /** Ref the file-history overlay anchors to: the tip for ranges, the commit otherwise. */
  const historyRef = range ? range.head : (commit?.hash ?? null)

  return (
    <div className="graph-detail">
      {range ? (
        <RangeHead range={range} prs={branchPrs} />
      ) : commit ? (
        <CommitHead
          commit={commit}
          repoPath={repoPath}
          squashedBranches={squashedBranches}
          onSelectBranch={onSelectBranch}
          githubWebUrl={githubWebUrl}
          onSetupAi={onSetupAi}
        />
      ) : null}

      <div className="section-head graph-detail__count">
        {filesLoading ? (
          filesSpin ? (
            'Loading…'
          ) : (
            ' '
          )
        ) : (
          <>
            {filterActive
              ? `${visibleFiles.length} of ${files.length}`
              : pluralize(files.length, 'file')}
            <DiffStat files={files} />
          </>
        )}
      </div>
      {!filesLoading && files.length > 0 && filterBar}
      <div className="tree-wrap">
        {filesLoading ? (
          filesSpin && (
            <div className="center-state">
              <div className="spinner" />
            </div>
          )
        ) : files.length === 0 ? (
          <div className="list-empty">
            {range ? 'This branch has no changes.' : 'No file changes in this commit.'}
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="list-empty">No files match the filter.</div>
        ) : (
          <WorkingFileList
            key={selectionKey}
            files={visibleFiles}
            selectedPath={selectedFilePath}
            // Read-only list: deselecting everything keeps the last diff.
            onSelect={(path) => path !== null && onSelectFile(path)}
            highlight={filterQuery}
            onSelectionChange={onFileSelectionChange}
            contextMenuFor={(selected) =>
              selected.length === 1 && historyRef
                ? [
                    ...fileHistoryItems(selected[0], historyRef, onOpenFileHistory),
                    {},
                    ...copyPathItems(selected, repoPath)
                  ]
                : copyPathItems(selected, repoPath)
            }
          />
        )}
      </div>
    </div>
  )
}
