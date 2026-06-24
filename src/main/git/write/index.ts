// Mutating git operations for the main process: staging, commits, branches,
// stash, merge/rebase machinery, worktrees and submodules. Split by domain
// into the sibling modules below; this barrel is the stable public surface
// (`import * as gitWrite from './git/write'`). The shared spawn-based runner
// and per-repo write queue live in exec.ts; network operations in sync.ts; the
// scripted interactive rebase in rebase.ts.
//
// Commit signing (gpg/ssh) is inherited from the user's git config — commits
// run through the real `git commit`, so `commit.gpgsign` et al. apply exactly
// as they do in the terminal.

export {
  checkoutBranch,
  checkoutDetached,
  createBranch,
  deleteBranch,
  renameBranch
} from './branches'
export { type CommitSelectionPayload, commitSelection, lastCommitMessage } from './commits'
export { markResolved, openMergeTool, resolveConflict } from './conflicts'
export { type DiscardPlan, discardFiles, planDiscard } from './discard'
export { appendIgnoreEntries, ignorePatterns } from './ignore'
export { AUTO_STASH_MARKER } from './internal'
export { optimizeRepo } from './maintenance'
export {
  abortOp,
  cherryPick,
  commitMerge,
  continueOp,
  merge,
  mergeMessage,
  rebase,
  reset,
  revertCommit,
  skipRebaseCommit
} from './merge'
export { applyPatch, stageAll, stageFiles, unstageAll, unstageFiles } from './staging'
export { listStashes, parseStashList, stashApply, stashDrop, stashSave } from './stash'
export { listSubmodules, parseSubmodules, updateSubmodules } from './submodules'
export { createTag, deleteTag } from './tags'
export { addWorktree, listWorktrees, parseWorktrees, removeWorktree } from './worktrees'
