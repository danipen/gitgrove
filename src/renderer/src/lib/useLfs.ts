// Git LFS health of the open repo (null = not probed / not applicable), whether
// the user waved the banner away for this repo session, and the one-click
// enable. Probed once per repo open — cheap (a handful of config reads) and
// silent for the overwhelming majority of repos that don't use LFS.

import type { LfsHealth } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'

export function useLfs(
  repoPath: string | undefined,
  getRepoPath: () => string | undefined,
  fail: (e: unknown) => void,
  notify: (message: string) => void
) {
  const [lfsHealth, setLfsHealth] = useState<LfsHealth | null>(null)
  const [lfsDismissed, setLfsDismissed] = useState(false)
  const [lfsEnabling, setLfsEnabling] = useState(false)

  const probeLfsHealth = useCallback((path: string) => {
    let stale = false
    window.gitgrove
      .lfsHealth(path)
      .then((health) => {
        if (!stale) setLfsHealth(health)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])

  useEffect(() => {
    setLfsHealth(null)
    setLfsDismissed(false)
    if (!repoPath) return
    return probeLfsHealth(repoPath)
  }, [repoPath, probeLfsHealth])

  const enableLfs = useCallback(async () => {
    const path = getRepoPath()
    if (!path) return
    setLfsEnabling(true)
    try {
      await window.gitgrove.lfsEnable(path)
      setLfsHealth(await window.gitgrove.lfsHealth(path))
      notify('Git LFS is set up — large files now download and upload correctly.')
    } catch (e) {
      fail(e)
    } finally {
      setLfsEnabling(false)
    }
  }, [getRepoPath, fail, notify])

  const dismissLfs = useCallback(() => setLfsDismissed(true), [])

  return { lfsHealth, lfsDismissed, dismissLfs, lfsEnabling, enableLfs, probeLfsHealth }
}
