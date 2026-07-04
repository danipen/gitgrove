// The Graph tab's sidebar pane: what the current selection changed. Two
// selection shapes share it — a single commit (node click) and a whole branch
// (label click: everything between the branch's base and its tip). Clicking a
// file drives the shared diff pane under the diagram — the History tab's
// files panel, arranged for the graph's sidebar.
// styles: styles/features/graph.css

import type { ChangedFile, Commit } from '@shared/types'
import { useEffect } from 'react'
import { AiExplainCommit } from '@/components/common/AiExplainCommit'
import { copyPathItems } from '@/components/common/copyPathItems'
import { useFileFilter } from '@/components/common/FileFilter'
import { type FileHistoryMode, fileHistoryItems } from '@/components/common/fileHistoryItems'
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
import { useSpinDelay } from '@/lib/useSpinDelay'
import type { BranchRange } from './useBranchRange'

interface Props {
  repoPath: string
  /** The selected commit — shown when no branch range is open. */
  commit: Commit | null
  /** The open branch-changes selection; wins over `commit` when set. */
  range: BranchRange | null
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
  onSetupAi
}: {
  commit: Commit
  repoPath: string
  onSetupAi: () => void
}) {
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
      <CommitMeta commit={commit} />
      {/* Keyed by hash: switching commits remounts the body, resetting its
          collapse state and re-probing overflow (see CommitBody). */}
      <CommitBody key={commit.hash} commit={commit} />
      <AiExplainCommit repoPath={repoPath} hash={commit.hash} onSetupAi={onSetupAi} />
      <CommitRefs key={`refs-${commit.hash}`} commit={commit} />
    </div>
  )
}

function RangeHead({ range }: { range: BranchRange }) {
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
    </div>
  )
}

export function GraphDetailPane({
  repoPath,
  commit,
  range,
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
        <RangeHead range={range} />
      ) : commit ? (
        <CommitHead commit={commit} repoPath={repoPath} onSetupAi={onSetupAi} />
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
