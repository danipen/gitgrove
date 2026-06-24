// The diff machinery: produce a DiffPayload for a working-tree or commit file —
// running the right `git diff`, finalizing it (size caps, LFS/submodule/binary/
// image special-cases), and attaching full old/new contents for expandable
// context where it's cheap and safe.

import type { ChangedFile, DiffArea, DiffPayload, FileStatus } from '@shared/types'
import { imageMimeType, loadCommitImageSides, loadWorkingImageSides } from '../image'
import { describeLfsPatch } from '../lfs-pointer'
import { describeSubmodulePatch } from '../submodule-patch'
import {
  EMPTY_TREE,
  GitOutputTooLargeError,
  isNoParentError,
  MAX_CONTENTS_BYTES,
  readWorkingFile,
  runGit,
  showFile
} from './core'

/** Refuse to ship patches larger than this to the renderer (bytes). */
const MAX_PATCH_BYTES = 3 * 1024 * 1024

/** The payload for a diff whose text exceeded `runGit`'s output buffer. */
function tooLargeDiff(base: Omit<DiffPayload, 'patch' | 'binary' | 'notice'>): DiffPayload {
  return { ...base, patch: '', binary: false, notice: 'This diff is too large to display.' }
}

function finalizeDiff(
  payload: Omit<DiffPayload, 'binary' | 'notice'> & { patch: string }
): DiffPayload {
  const { patch } = payload
  const binary = /^Binary files |GIT binary patch/m.test(patch)
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    return {
      ...payload,
      patch: '',
      binary,
      notice: 'This diff is too large to display.'
    }
  }
  // LFS-tracked files diff as pointer text (both sides run through the clean
  // filter) — oid/size churn no user should have to read. Ship the object
  // sizes instead; the viewer renders a dedicated LFS panel.
  const lfs = describeLfsPatch(patch)
  if (lfs) {
    return {
      ...payload,
      patch: '',
      binary: false,
      lfs,
      notice: 'This file is stored with Git LFS — its content lives outside the repository.'
    }
  }
  // Submodule (gitlink) changes diff as "Subproject commit <sha>" plumbing
  // text — ship the structured commit movement instead; the viewer renders a
  // dedicated submodule panel.
  const submodule = describeSubmodulePatch(patch)
  if (submodule) {
    return { ...payload, patch: '', binary: false, submodule }
  }
  if (binary && !patch.includes('@@')) {
    return { ...payload, binary, notice: 'Binary file — no textual diff available.' }
  }
  return { ...payload, binary }
}

/**
 * Attach full old/new contents to a diff payload so the viewer can render an
 * expandable diff. No-ops (returns the payload unchanged) when either side is
 * unreadable or the combined size exceeds the cap.
 */
function withContents(
  payload: DiffPayload,
  oldContents: string | null,
  newContents: string | null
): DiffPayload {
  if (oldContents == null || newContents == null) return payload
  const size = Buffer.byteLength(oldContents, 'utf8') + Buffer.byteLength(newContents, 'utf8')
  if (size > MAX_CONTENTS_BYTES) return payload
  return { ...payload, oldContents, newContents }
}

export async function getWorkingDiff(
  repoPath: string,
  file: ChangedFile,
  area: DiffArea = 'all'
): Promise<DiffPayload> {
  const status =
    area === 'staged'
      ? (file.indexStatus ?? file.status)
      : area === 'unstaged'
        ? (file.workingStatus ?? file.status)
        : file.status
  const base = { path: file.path, oldPath: file.oldPath, status }
  let patch = ''

  try {
    if (file.status === 'untracked' || (area === 'unstaged' && status === 'untracked')) {
      // Untracked files have no index entry; diff against /dev/null. git returns
      // exit code 1 when the files differ, which is expected here.
      patch = await runGit(
        repoPath,
        ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path],
        [1]
      )
    } else if (area === 'staged') {
      // Index vs HEAD: exactly what `commit` would record for this file.
      const args = ['diff', '--no-color', '--cached', '-M', '--', file.path]
      if (file.oldPath) args.push(file.oldPath)
      patch = await runGit(repoPath, args, [1])
    } else if (area === 'unstaged') {
      // Working tree vs index: what's left to stage.
      patch = await runGit(repoPath, ['diff', '--no-color', '--', file.path], [1])
    } else {
      // Everything tracked: full working-tree state (staged + unstaged) vs HEAD.
      const args = ['diff', '--no-color', 'HEAD', '--', file.path]
      if (file.oldPath) args.push(file.oldPath)
      patch = await runGit(repoPath, args, [1])
    }
  } catch (e) {
    if (e instanceof GitOutputTooLargeError) return tooLargeDiff(base)
    throw e
  }

  const payload = finalizeDiff({ ...base, patch })
  // LFS pointers and submodules own their panels — never treat them as images
  // (the LFS "old side" blob would be pointer text, not pixels).
  if (payload.lfs || payload.submodule) return payload

  // Renderable image: ship both sides as data URLs and let the viewer take
  // over. SVG additionally keeps its text diff (it IS text) so the viewer can
  // offer an Image ⇄ Code toggle; rasters drop the "binary file" notice.
  // Rasters must never ship text contents: a rename-only jpeg diffs to just
  // the rename header (no "Binary files differ" line, binary=false), which
  // would otherwise read as a diffable text file and attach raw image bytes
  // decoded as utf8.
  const mime = imageMimeType(file.path)
  if (mime) {
    const image = await loadWorkingImageSides(repoPath, file, status, area)
    if (image) {
      if (mime === 'image/svg+xml' && !payload.binary && !payload.notice) {
        return { ...(await attachWorkingContents(payload, repoPath, file, status, area)), image }
      }
      return { ...payload, notice: undefined, image }
    }
  }
  if (payload.notice || payload.binary) return payload

  return attachWorkingContents(payload, repoPath, file, status, area)
}

/**
 * Attach the full old/new text contents matching a working diff, so the
 * viewer can expand context. `:0` is the index (stage 0); HEAD is the last
 * commit. The old side of an unstaged diff is the index; everything else
 * diffs from HEAD. No-ops for statuses with no expandable sides.
 */
async function attachWorkingContents(
  payload: DiffPayload,
  repoPath: string,
  file: ChangedFile,
  status: FileStatus,
  area: DiffArea
): Promise<DiffPayload> {
  const oldSideRef = area === 'unstaged' ? ':0' : 'HEAD'
  const newFromIndex = (path: string) => showFile(repoPath, ':0', path)
  let oldContents: string | null
  let newContents: string | null
  switch (status) {
    case 'untracked':
    case 'added':
      oldContents = ''
      newContents =
        area === 'staged'
          ? await newFromIndex(file.path)
          : await readWorkingFile(repoPath, file.path)
      break
    case 'deleted':
      oldContents = await showFile(repoPath, oldSideRef, file.oldPath ?? file.path)
      newContents = ''
      break
    case 'modified':
    case 'renamed':
      oldContents = await showFile(repoPath, oldSideRef, file.oldPath ?? file.path)
      newContents =
        area === 'staged'
          ? await newFromIndex(file.path)
          : await readWorkingFile(repoPath, file.path)
      break
    default:
      // conflicted / ignored: leave non-expandable.
      return payload
  }

  return withContents(payload, oldContents, newContents)
}

export async function getCommitDiff(
  repoPath: string,
  hash: string,
  file: ChangedFile
): Promise<DiffPayload> {
  const base = { path: file.path, oldPath: file.oldPath, status: file.status }

  // Try the first parent directly; only root commits fail, and they retry
  // against the empty tree — one spawn in the common case instead of a
  // rev-parse probe plus the diff.
  const paths = file.oldPath ? [file.path, file.oldPath] : [file.path]
  let hasParent = true
  let patch: string
  try {
    patch = await runGit(
      repoPath,
      ['diff', '--no-color', '-M', `${hash}^`, hash, '--', ...paths],
      [1]
    )
  } catch (e) {
    if (e instanceof GitOutputTooLargeError) return tooLargeDiff(base)
    if (!isNoParentError(e)) throw e
    hasParent = false
    try {
      patch = await runGit(
        repoPath,
        ['diff', '--no-color', '-M', EMPTY_TREE, hash, '--', ...paths],
        [1]
      )
    } catch (e2) {
      if (e2 instanceof GitOutputTooLargeError) return tooLargeDiff(base)
      throw e2
    }
  }
  const payload = finalizeDiff({ ...base, patch })
  if (payload.lfs || payload.submodule) return payload

  // Same image hand-off as working diffs: data-URL sides for the image
  // viewer; only SVG keeps its text diff for the Image ⇄ Code toggle (see
  // getWorkingDiff for why rasters must not ship text contents).
  const mime = imageMimeType(file.path)
  if (mime) {
    const image = await loadCommitImageSides(repoPath, hash, file, hasParent)
    if (image) {
      if (mime === 'image/svg+xml' && !payload.binary && !payload.notice) {
        return { ...(await attachCommitContents(payload, repoPath, hash, file, hasParent)), image }
      }
      return { ...payload, notice: undefined, image }
    }
  }
  if (payload.notice || payload.binary) return payload

  return attachCommitContents(payload, repoPath, hash, file, hasParent)
}

/** Attach the full old/new text contents matching a commit diff. */
async function attachCommitContents(
  payload: DiffPayload,
  repoPath: string,
  hash: string,
  file: ChangedFile,
  hasParent: boolean
): Promise<DiffPayload> {
  const oldContents =
    file.status === 'added' || !hasParent
      ? ''
      : await showFile(repoPath, `${hash}^`, file.oldPath ?? file.path)
  const newContents = file.status === 'deleted' ? '' : await showFile(repoPath, hash, file.path)

  return withContents(payload, oldContents, newContents)
}
