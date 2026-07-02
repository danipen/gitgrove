// Image-diff support for the read side: detect renderable image paths and load
// both sides of a change as data URLs (see ImageDiffSides in shared/types).
//
// Blob reads here must be binary-safe: `read.ts`'s runGit decodes stdout as
// utf8, which corrupts arbitrary bytes, so this module has its own buffer-mode
// `git show` runner. Reads inherit GIT_OPTIONAL_LOCKS=0 from read.ts (set on
// process.env), so they never take the index lock.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  ChangedFile,
  DiffArea,
  FileStatus,
  ImageContents,
  ImageDiffSides
} from '@shared/types'
import { locateGit } from './bin'

const execFileAsync = promisify(execFile)

/**
 * Hard cap per side (bytes). Images cross the IPC boundary base64-encoded
 * (~1.37×), so this bounds the renderer payload at ~55 MB worst case — large
 * enough for any reviewable asset, small enough to never stall the bridge.
 * Bigger files keep the plain "binary file" notice.
 */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024

/**
 * Extensions Chromium can decode natively (the renderer paints with <img> and
 * canvas — no decoding library ships with the app). TIFF, PSD, HEIC etc. are
 * deliberately absent: they would render a broken image.
 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/**
 * The MIME type the renderer can display this path as, or null when it isn't a
 * renderable image. Pure (extension-based, case-insensitive) + exported for
 * tests. Extension sniffing is the right tool here: it must agree with what
 * the <img> tag will do, which also keys off the data-URL MIME we derive.
 */
export function imageMimeType(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return null
  const ext = path.slice(dot + 1).toLowerCase()
  // A dot inside a directory name must not count ("assets.v2/logo").
  if (ext.includes('/') || ext.includes('\\')) return null
  return IMAGE_MIME_BY_EXT[ext] ?? null
}

function toImageContents(buf: Buffer, mime: string): ImageContents | null {
  if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.byteLength }
}

/** Read a blob at a ref (`git show <ref>:<path>`) as raw bytes; null if absent. */
async function showFileBuffer(repoPath: string, ref: string, path: string): Promise<Buffer | null> {
  const bin = await locateGit()
  try {
    const { stdout } = await execFileAsync(bin, ['show', `${ref}:${path}`], {
      cwd: repoPath,
      encoding: 'buffer',
      maxBuffer: MAX_IMAGE_BYTES + 1024,
      windowsHide: true
    })
    return stdout
  } catch {
    return null
  }
}

/** Read a working-tree file as raw bytes; null if unreadable. */
async function readWorkingBuffer(repoPath: string, path: string): Promise<Buffer | null> {
  try {
    return await readFile(join(repoPath, path))
  } catch {
    return null
  }
}

const asContents = (buf: Buffer | null, mime: string) => (buf ? toImageContents(buf, mime) : null)

/**
 * Both sides of a working-tree image change, mirroring exactly the revisions
 * `getWorkingDiff` diffs for the same area: the old side is HEAD (or the index
 * for unstaged diffs), the new side is the working tree (or the index for
 * staged diffs). Returns null when the change has no displayable side — the
 * caller keeps the regular binary notice.
 */
export async function loadWorkingImageSides(
  repoPath: string,
  file: ChangedFile,
  status: FileStatus,
  area: DiffArea
): Promise<ImageDiffSides | null> {
  const mime = imageMimeType(file.path)
  if (!mime) return null
  const oldRef = area === 'unstaged' ? ':0' : 'HEAD'
  const readNew = () =>
    area === 'staged'
      ? showFileBuffer(repoPath, ':0', file.path)
      : readWorkingBuffer(repoPath, file.path)
  const readOld = () => showFileBuffer(repoPath, oldRef, file.oldPath ?? file.path)

  switch (status) {
    case 'untracked':
    case 'added':
      return packSides(null, asContents(await readNew(), mime))
    case 'deleted':
      return packSides(asContents(await readOld(), mime), null)
    case 'modified':
    case 'renamed': {
      const [oldBuf, newBuf] = await Promise.all([readOld(), readNew()])
      return packModifiedSides(asContents(oldBuf, mime), asContents(newBuf, mime))
    }
    default:
      // conflicted/ignored: the conflict panel / nothing owns these.
      return null
  }
}

/** Both sides of an image change inside a commit (first-parent vs commit). */
export async function loadCommitImageSides(
  repoPath: string,
  hash: string,
  file: ChangedFile,
  hasParent: boolean
): Promise<ImageDiffSides | null> {
  return loadRefImageSides(repoPath, hasParent ? `${hash}^` : null, hash, file)
}

/**
 * Image sides between two arbitrary refs — the commit case above (`hash^` →
 * `hash`) and the Graph tab's branch-changes range (`base` → `head`). A null
 * `oldRef` means no old side exists (root commit / chain start).
 */
export async function loadRefImageSides(
  repoPath: string,
  oldRef: string | null,
  newRef: string,
  file: ChangedFile
): Promise<ImageDiffSides | null> {
  const mime = imageMimeType(file.path)
  if (!mime) return null
  const hasOld = file.status !== 'added' && oldRef !== null
  const hasNew = file.status !== 'deleted'
  const [oldSide, newSide] = await Promise.all([
    oldRef !== null && hasOld
      ? showFileBuffer(repoPath, oldRef, file.oldPath ?? file.path).then((b) => asContents(b, mime))
      : Promise.resolve(null),
    hasNew
      ? showFileBuffer(repoPath, newRef, file.path).then((b) => asContents(b, mime))
      : Promise.resolve(null)
  ])
  if (hasOld && hasNew) return packModifiedSides(oldSide, newSide)
  return packSides(oldSide, newSide)
}

/**
 * A change with no displayable side (missing, empty, over the size cap) falls
 * back to the regular binary notice rather than an empty viewer.
 */
function packSides(
  oldSide: ImageContents | null,
  newSide: ImageContents | null
): ImageDiffSides | null {
  if (oldSide === null && newSide === null) return null
  return { old: oldSide, new: newSide }
}

/**
 * For a modification both sides must be displayable: shipping only one would
 * make the viewer lie ("added"/"deleted") about a file that merely failed the
 * size cap on one side. All-or-nothing keeps the UI honest.
 */
function packModifiedSides(
  oldSide: ImageContents | null,
  newSide: ImageContents | null
): ImageDiffSides | null {
  if (oldSide === null || newSide === null) return null
  return { old: oldSide, new: newSide }
}
