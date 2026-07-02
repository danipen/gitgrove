// Read-side git access for the main process. Split by domain into the sibling
// modules below; this barrel is the stable public surface
// (`import { ... } from './git/read'`). The thin execFile runner and shared
// read primitives live in core.ts; everything reads through it.
//
// All output that contains file paths or user text is NUL-delimited (`-z` /
// `%x00`), because NUL is the only byte git guarantees can never appear inside
// refnames, paths, or commit messages.

export { getBlame, parseBlamePorcelain } from './blame'
export { getBranches, getQuickSummary, parseRecentBranches } from './branches'
export {
  addSafeDirectory,
  DubiousOwnershipError,
  GitOutputTooLargeError,
  resolveRepoRoot,
  runGit
} from './core'
export { getCommitDiff, getRangeDiff, getWorkingDiff } from './diff'
export { getCommitFiles, getRangeFiles, parseRawNumstat } from './files'
export { getGraphLog } from './graph'
export { getCommitIndex, getFileHistory, getLog, getUnpushedCommits } from './log'
export {
  countConflictMarkers,
  getConflictSides,
  getMergePreview,
  getMergeToolName,
  parseMergeTreeNames
} from './merge'
export { getRemoteCloneUrl, getRemoteWebUrl, toWebUrl } from './remotes'
