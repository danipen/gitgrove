// Credential prompts pushed from main while a network op waits on auth. A queue
// because git asks in steps (username, then password) and parallel ops can
// overlap — the dialog shows them one at a time, oldest first. `oauth` marks
// prompts whose host supports one-click browser sign-in. Fully self-contained:
// it queues arrivals, drops expirations, and answers over IPC.

import type { CredentialPromptRequest } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'

export function useCredentialPrompts() {
  const [credentialPrompts, setCredentialPrompts] = useState<
    Array<CredentialPromptRequest & { oauth: boolean }>
  >([])

  useEffect(
    () =>
      window.gitgrove.onCredentialPrompt((request) => {
        // Queue in arrival order immediately — the OAuth probe is async, and
        // awaiting it before enqueuing could reorder two prompts racing in.
        // Reaching here means no connected account answered silently; resolve
        // whether the host supports one-click browser sign-in and flip the flag
        // on the queued prompt when it does (it both rescues this prompt and
        // connects the account for every future operation).
        setCredentialPrompts((prev) => [...prev, { ...request, oauth: false }])
        if (!request.host) return
        window.gitgrove
          .hasOAuthClient(request.host)
          .then((oauth) => {
            if (!oauth) return
            setCredentialPrompts((prev) =>
              prev.map((p) => (p.requestId === request.requestId ? { ...p, oauth: true } : p))
            )
          })
          .catch(() => {})
      }),
    []
  )
  useEffect(
    () =>
      window.gitgrove.onCredentialDismiss((requestId) =>
        setCredentialPrompts((prev) => prev.filter((p) => p.requestId !== requestId))
      ),
    []
  )

  const respondCredential = useCallback((requestId: string, value: string | null) => {
    setCredentialPrompts((prev) => prev.filter((p) => p.requestId !== requestId))
    window.gitgrove.respondCredential(requestId, value).catch(() => {})
  }, [])

  return { credentialPrompts, respondCredential }
}
