// Commit identity, git credential prompts, and connected accounts — kept in
// one module because they share state: the credential responder answers
// silently from a connected account when it can, and a sign-in that completes
// while git is waiting must settle the pending prompt it was blocked on.
//
// Secrets pass through the in-memory resolvers only — never logged, never
// persisted, and each map entry is dropped the moment it settles.

import { normalizeHost } from '@shared/git-hosts'
import { IPC } from '@shared/ipc'
import type { CredentialPrompt, CredentialPromptRequest, IdentityScope } from '@shared/types'
import { ipcMain } from 'electron'
import { lookupAvatarUrl } from '../accounts/avatar'
import { accountsStore } from '../accounts/cipher'
import { connectViaOAuth, connectWithToken, oauthClientIdFor } from '../accounts/connect'
import { fetchRepositories } from '../accounts/github'
import { answerFromAccounts } from '../accounts/store'
import { setCredentialResponder } from '../git/askpass'
import { rejectStoredCredential } from '../git/credential-store'
import { getGlobalIdentity, getIdentity, setGlobalIdentity, setIdentity } from '../git/identity'
import type { HandlerDeps } from './context'

export function registerAccountHandlers(deps: HandlerDeps): void {
  const { focusedWindow, broadcast } = deps

  // ── Commit identity ──
  ipcMain.handle(IPC.getIdentity, (_e, repoPath: string) => getIdentity(repoPath))
  ipcMain.handle(
    IPC.setIdentity,
    (_e, repoPath: string, name: string, email: string, scope: IdentityScope) =>
      setIdentity(repoPath, name, email, scope)
  )
  ipcMain.handle(IPC.getGlobalIdentity, () => getGlobalIdentity())
  ipcMain.handle(IPC.setGlobalIdentity, (_e, name: string, email: string) =>
    setGlobalIdentity(name, email)
  )

  // ── Credential prompts ──
  // Askpass bridge: when a network op hits a credential prompt, the askpass
  // server (git/askpass.ts) calls this responder. A connected account for the
  // prompt's host answers silently (login for the username, token for the
  // password); only strangers reach the renderer's CredentialDialog.
  let credentialSeq = 0
  const pendingCredentials = new Map<
    string,
    { prompt: CredentialPrompt; settle: (value: string | null) => void }
  >()
  setCredentialResponder((prompt, signal) => {
    const silent = answerFromAccounts(accountsStore(), prompt)
    if (silent !== null) return Promise.resolve(silent)
    // The prompt goes to the window the user is working in — the op that hit
    // it almost always started there, and popping the same dialog in every
    // window would leave orphaned copies (each window closes only the dialog
    // it answered). Dismissals broadcast instead: focus may have moved since,
    // and only the window showing that requestId reacts.
    const window = focusedWindow()
    // No window to ask — cancel so the operation fails fast instead of hanging.
    if (!window) return Promise.resolve(null)
    const requestId = `credential-${++credentialSeq}`
    return new Promise<string | null>((resolve) => {
      const settle = (value: string | null) => {
        if (pendingCredentials.delete(requestId)) resolve(value)
      }
      pendingCredentials.set(requestId, { prompt, settle })
      // The server aborts unanswered prompts (10 min): cancel and close the
      // renderer's dialog too, so it can't answer into the void after the
      // git operation has already failed.
      signal.addEventListener('abort', () => {
        settle(null)
        broadcast(IPC.credentialDismiss, requestId)
      })
      const request: CredentialPromptRequest = { requestId, ...prompt }
      window.webContents.send(IPC.credentialPrompt, request)
    })
  })
  ipcMain.handle(IPC.credentialRespond, (_e, requestId: string, value: string | null) => {
    pendingCredentials.get(requestId)?.settle(value)
  })

  // ── Connected accounts ──
  /**
   * A sign-in completed while git was already waiting on a prompt for that
   * host (the in-dialog "Sign in with GitHub" path): answer the waiting
   * prompt from the new account and close its dialog — the user finished in
   * the browser; asking them to also paste something would be absurd.
   */
  const answerPendingPromptsFor = (host: string) => {
    const wanted = normalizeHost(host)
    for (const [requestId, pending] of pendingCredentials) {
      if (!pending.prompt.host || normalizeHost(pending.prompt.host) !== wanted) continue
      const answer = answerFromAccounts(accountsStore(), pending.prompt)
      if (answer !== null) {
        pending.settle(answer)
        broadcast(IPC.credentialDismiss, requestId)
      }
    }
  }

  /**
   * After any successful connect: purge stale credential-helper copies (they
   * answer before askpass and would shadow the fresh token until a 401),
   * settle any waiting prompt, and tell the renderer to refetch the list.
   */
  const afterConnect = async (host: string) => {
    await rejectStoredCredential(host)
    answerPendingPromptsFor(host)
    // Every window's settings pane and clone dialog shows the accounts list.
    broadcast(IPC.accountsChanged)
  }

  ipcMain.handle(IPC.accountsList, () => accountsStore().listAccounts())
  ipcMain.handle(
    IPC.accountsHasOAuthClient,
    (_e, host: string) => oauthClientIdFor(accountsStore(), host) !== null
  )
  ipcMain.handle(IPC.accountsLookupAvatar, (_e, email: string) =>
    lookupAvatarUrl(accountsStore(), email)
  )
  ipcMain.handle(IPC.accountRepos, (e, accountId: string) => {
    const store = accountsStore()
    const account = store.listAccounts().find((a) => a.id === accountId)
    const token = account && store.getTokenForHost(account.host)
    if (!account || !token) throw new Error('That account is no longer connected.')
    // Pages stream back to the window whose picker asked for them.
    return fetchRepositories(account.host, token, fetch, (repos) => {
      if (!e.sender.isDestroyed()) e.sender.send(IPC.accountReposPage, { accountId, repos })
    })
  })

  // One sign-in at a time: a newly started flow supersedes (aborts) the old.
  let oauthInFlight: AbortController | null = null
  ipcMain.handle(IPC.accountsBeginOAuth, async (e, host: string, clientId?: string) => {
    oauthInFlight?.abort()
    const controller = new AbortController()
    oauthInFlight = controller
    const result = await connectViaOAuth(accountsStore(), host, {
      clientId,
      signal: controller.signal,
      // The user code belongs in the window whose sign-in dialog is open.
      onDeviceCode: (info) => {
        if (!e.sender.isDestroyed()) e.sender.send(IPC.accountsDeviceCode, info)
      }
    })
    if (oauthInFlight === controller) oauthInFlight = null
    if (result.ok) await afterConnect(result.account.host)
    return result
  })
  ipcMain.handle(IPC.accountsCancelOAuth, () => {
    oauthInFlight?.abort()
    oauthInFlight = null
  })
  ipcMain.handle(IPC.accountsAddToken, async (_e, host: string, token: string) => {
    const result = await connectWithToken(accountsStore(), host, token)
    if (result.ok) await afterConnect(result.account.host)
    return result
  })
  ipcMain.handle(IPC.accountsRemove, async (_e, id: string) => {
    const removed = accountsStore().removeAccount(id)
    // The OS helper still holds the token git stored on the last success —
    // sign-out must actually sign the machine out, not just forget metadata.
    if (removed) await rejectStoredCredential(removed.host)
    broadcast(IPC.accountsChanged)
  })
}
