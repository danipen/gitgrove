// Git availability gates the whole UI: null while the (fast) launch probe runs,
// then a value the app uses to swap in the setup screen when git is missing.
// `recheckGit` re-probes on demand (the setup screen's "Check again").

import type { GitAvailability } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'

export function useGitAvailability() {
  const [git, setGit] = useState<GitAvailability | null>(null)
  const [gitChecking, setGitChecking] = useState(false)

  // Probe on launch.
  useEffect(() => {
    window.gitgrove
      .checkGit()
      .then(setGit)
      .catch(() => setGit({ available: false, platform: 'win32' }))
  }, [])

  const recheckGit = useCallback(async () => {
    setGitChecking(true)
    try {
      setGit(await window.gitgrove.checkGit(true))
    } finally {
      setGitChecking(false)
    }
  }, [])

  return { git, gitChecking, recheckGit }
}
