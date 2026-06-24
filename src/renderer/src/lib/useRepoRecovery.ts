// Missing-repo recovery: when the open repo's folder has vanished, the
// workspace is swapped for the recovery screen (Locate / Clone Again / Remove /
// Check again). This hook owns the `recovering` flag (drives "Check again") and
// the four actions; the `missingRepo` state itself stays in App because the
// open/lifecycle path sets and clears it.

import type { RepoOpenResult } from '@shared/types'
import { useCallback, useState } from 'react'
import type { Modal } from '../components/app/AppModals'

export interface MissingRepoInfo {
  path: string
  name: string
  remoteUrl: string | null
}

interface Params {
  missingRepo: MissingRepoInfo | null
  setMissingRepo: (value: MissingRepoInfo | null) => void
  handleOpen: (res: RepoOpenResult) => void
  fail: (e: unknown) => void
  openModal: (modal: Modal) => void
}

export function useRepoRecovery({
  missingRepo,
  setMissingRepo,
  handleOpen,
  fail,
  openModal
}: Params) {
  const [recovering, setRecovering] = useState(false)

  const recoverCheckAgain = useCallback(async () => {
    if (!missingRepo) return
    setRecovering(true)
    try {
      handleOpen(await window.gitgrove.openRepo(missingRepo.path))
    } catch (e) {
      fail(e)
    } finally {
      setRecovering(false)
    }
  }, [missingRepo, handleOpen, fail])

  const recoverLocate = useCallback(async () => {
    if (!missingRepo) return
    const stalePath = missingRepo.path
    try {
      const res = await window.gitgrove.pickRepo()
      if (!res) return
      // Opened a folder elsewhere — forget the dead path so it stops haunting
      // the recents (the newly-opened one was just remembered under its path).
      if (res.ok) await window.gitgrove.removeRecent(stalePath)
      handleOpen(res)
    } catch (e) {
      fail(e)
    }
  }, [missingRepo, handleOpen, fail])

  const recoverRemove = useCallback(async () => {
    if (!missingRepo) return
    await window.gitgrove.removeRecent(missingRepo.path).catch(() => {})
    setMissingRepo(null)
  }, [missingRepo, setMissingRepo])

  const recoverCloneAgain = useCallback(() => {
    if (!missingRepo?.remoteUrl) return
    // Clone back into the same parent folder; the dialog composes the leaf from
    // the repo name and a successful clone replaces the missing recent in place.
    const trimmed = missingRepo.path.replace(/[\\/]+$/, '')
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    const baseDir = cut > 0 ? trimmed.slice(0, cut) : trimmed
    openModal({ kind: 'clone', initial: { url: missingRepo.remoteUrl, baseDir } })
  }, [missingRepo, openModal])

  return { recovering, recoverCheckAgain, recoverLocate, recoverRemove, recoverCloneAgain }
}
