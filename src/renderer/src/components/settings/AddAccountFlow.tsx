// The "Add account" steps inside the Accounts dialog. Kept deliberately
// shallow: github.com is one click into the browser (device flow); Enterprise
// asks for the server, then takes the path that needs no setup — paste a
// token via a pre-filled creation page — while a one-time client ID unlocks
// the same browser sign-in for that host forever (remembered in main).

import { hostFromInput, isGitHubDotCom, tokenCreationUrl } from '@shared/git-hosts'
import type { AccountErrorCode, ConnectedAccount, DeviceCodeInfo } from '@shared/types'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Icon } from '@/lib/icons'
import { DeviceCodePanel } from './DeviceCodePanel'

type Step =
  | { id: 'choose' }
  | { id: 'enterprise-url' }
  | { id: 'token'; host: string }
  | { id: 'device'; host: string }

interface Props {
  onDone: (account: ConnectedAccount) => void
  onCancel: () => void
  /**
   * Skip the provider chooser and go straight in — used when the surface
   * already names the provider (the clone dialog's GitHub.com / Enterprise
   * tabs). 'github' kicks off the browser sign-in; 'enterprise' opens the
   * server field. Omitted (the Settings pane) shows the chooser. With a
   * `start` set, the first step's Back button cancels the whole flow.
   */
  start?: 'github' | 'enterprise'
}

/** Human copy for the stable failure codes connect can come back with. */
function errorCopy(code: AccountErrorCode): string {
  switch (code) {
    case 'access-denied':
      return 'The sign-in was declined in the browser.'
    case 'expired':
      return 'The code expired before the sign-in finished — try again.'
    case 'network':
      return 'Could not reach the server — check the address and your connection.'
    case 'bad-token':
      return 'The server did not accept that token.'
    case 'bad-client-id':
      return 'The server does not know this app — check the client ID.'
    case 'cancelled':
      return ''
  }
}

export function AddAccountFlow({ onDone, onCancel, start }: Props) {
  const [step, setStep] = useState<Step>(
    start === 'enterprise' ? { id: 'enterprise-url' } : { id: 'choose' }
  )
  const [serverInput, setServerInput] = useState('')
  const [token, setToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [showClientId, setShowClientId] = useState(false)
  const [deviceInfo, setDeviceInfo] = useState<DeviceCodeInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const oauthRunning = useRef(false)

  useEffect(() => window.gitgrove.onAccountDeviceCode(setDeviceInfo), [])
  // Leaving the dialog mid-sign-in must stop the polling in main.
  useEffect(() => {
    return () => {
      if (oauthRunning.current) window.gitgrove.cancelAccountOAuth()
    }
  }, [])

  const fail = (code: AccountErrorCode, fallback: Step) => {
    setStep(fallback)
    setError(errorCopy(code) || null)
  }

  const startOAuth = async (host: string, withClientId?: string) => {
    const fallback: Step = isGitHubDotCom(host) ? { id: 'choose' } : { id: 'token', host }
    setError(null)
    setDeviceInfo(null)
    setStep({ id: 'device', host })
    oauthRunning.current = true
    const result = await window.gitgrove.beginAccountOAuth(host, withClientId)
    oauthRunning.current = false
    if (result.ok) onDone(result.account)
    else if (result.code !== 'cancelled') fail(result.code, fallback)
  }

  const chooseGitHub = async () => {
    // Without a built-in client ID (unregistered dev build) degrade to the
    // token path — never a dead end.
    if (await window.gitgrove.hasOAuthClient('github.com')) startOAuth('github.com')
    else setStep({ id: 'token', host: 'github.com' })
  }

  // start='github' enters straight into the browser sign-in (the clone
  // dialog's GitHub.com tab already named the provider). Once only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    if (start === 'github') chooseGitHub()
  }, [])

  const continueToServer = async (e?: FormEvent) => {
    e?.preventDefault()
    const host = hostFromInput(serverInput)
    if (!host) {
      setError('Enter your server, like github.example.com')
      return
    }
    if (isGitHubDotCom(host)) return chooseGitHub()
    // Entering a (possibly different) host's token step: drop any client ID
    // typed for a previous host so it can't be submitted against this one.
    setShowClientId(false)
    setClientId('')
    // A client ID remembered from an earlier sign-in makes this one click.
    if (await window.gitgrove.hasOAuthClient(host)) startOAuth(host)
    else setStep({ id: 'token', host })
  }

  const submitToken = async (e: FormEvent) => {
    e.preventDefault()
    if (step.id !== 'token' || !token.trim()) return
    setBusy(true)
    setError(null)
    const result = await window.gitgrove.addAccountWithToken(step.host, token)
    setBusy(false)
    if (result.ok) {
      setToken('')
      onDone(result.account)
    } else setError(errorCopy(result.code))
  }

  const cancelDevice = () => {
    window.gitgrove.cancelAccountOAuth()
    oauthRunning.current = false
    setStep({ id: 'choose' })
    setError(null)
  }

  switch (step.id) {
    case 'choose':
      return (
        <div className="acct-flow">
          {error && <p className="dlg-error">{error}</p>}
          <button type="button" className="acct-choice" onClick={chooseGitHub}>
            <Icon.Github size={20} />
            <span className="acct-choice__main">
              <span className="acct-choice__title">GitHub.com</span>
              <span className="acct-choice__sub">Sign in with your browser</span>
            </span>
          </button>
          <button
            type="button"
            className="acct-choice"
            onClick={() => {
              setError(null)
              setStep({ id: 'enterprise-url' })
            }}
          >
            <Icon.Repo size={20} />
            <span className="acct-choice__main">
              <span className="acct-choice__title">GitHub Enterprise</span>
              <span className="acct-choice__sub">Your company’s GitHub server</span>
            </span>
          </button>
          <div className="trust__actions">
            <button type="button" className="btn-ghost btn-ghost--sm" onClick={onCancel}>
              Back
            </button>
          </div>
        </div>
      )

    case 'enterprise-url':
      return (
        <form className="acct-flow" onSubmit={continueToServer}>
          <div className="dlg-field">
            <label htmlFor="acct-server">Enterprise server</label>
            <input
              id="acct-server"
              autoFocus
              placeholder="github.example.com"
              value={serverInput}
              onChange={(e) => {
                setError(null)
                setServerInput(e.target.value)
              }}
            />
          </div>
          {error && <p className="dlg-error">{error}</p>}
          <div className="trust__actions">
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              onClick={() => (start === 'enterprise' ? onCancel() : setStep({ id: 'choose' }))}
            >
              Back
            </button>
            <button type="submit" className="btn-primary btn-primary--sm">
              Continue
            </button>
          </div>
        </form>
      )

    case 'token':
      return (
        <form className="acct-flow" onSubmit={submitToken}>
          <p className="trust__body">
            Create an access token on <strong>{step.host}</strong> and paste it here — the page
            opens with the right permissions already selected.
          </p>
          <div className="dlg-field">
            <label htmlFor="acct-token">Access token</label>
            <div className="dlg-pickrow">
              <input
                id="acct-token"
                type="password"
                autoFocus
                autoComplete="off"
                placeholder="ghp_…"
                value={token}
                disabled={busy}
                onChange={(e) => {
                  setError(null)
                  setToken(e.target.value)
                }}
              />
              <button
                type="button"
                className="btn-ghost btn-ghost--sm"
                onClick={() => window.gitgrove.openExternal(tokenCreationUrl(step.host))}
              >
                Create token… <Icon.External size={12} />
              </button>
            </div>
          </div>
          {!isGitHubDotCom(step.host) &&
            (showClientId ? (
              <div className="dlg-field">
                <label htmlFor="acct-client-id">OAuth client ID</label>
                <div className="dlg-pickrow">
                  <input
                    id="acct-client-id"
                    autoComplete="off"
                    placeholder="Iv1.…"
                    value={clientId}
                    disabled={busy}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-primary btn-primary--sm"
                    disabled={busy || !clientId.trim()}
                    onClick={() => startOAuth(step.host, clientId.trim())}
                  >
                    Sign in with browser
                  </button>
                </div>
                <p className="trust__note">
                  From a “GitGrove” OAuth app registered on {step.host} (with device flow enabled).
                  Remembered after the first sign-in.
                </p>
              </div>
            ) : (
              <p className="trust__note">
                Skip tokens entirely?{' '}
                <button type="button" className="link-button" onClick={() => setShowClientId(true)}>
                  Use this server’s GitGrove OAuth app
                </button>
              </p>
            ))}
          {error && <p className="dlg-error">{error}</p>}
          <div className="trust__actions">
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              disabled={busy}
              onClick={() =>
                setStep(isGitHubDotCom(step.host) ? { id: 'choose' } : { id: 'enterprise-url' })
              }
            >
              Back
            </button>
            <button
              type="submit"
              className="btn-primary btn-primary--sm"
              disabled={busy || !token.trim()}
            >
              {busy && <span className="about__spinner" aria-hidden />}
              Connect
            </button>
          </div>
        </form>
      )

    case 'device':
      return (
        <div className="acct-flow">
          <DeviceCodePanel host={step.host} info={deviceInfo} />
          <div className="trust__actions">
            <button type="button" className="btn-ghost btn-ghost--sm" onClick={cancelDevice}>
              Cancel
            </button>
          </div>
        </div>
      )
  }
}
