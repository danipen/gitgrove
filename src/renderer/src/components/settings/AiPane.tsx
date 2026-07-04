// Settings → AI: connect a bring-your-own AI backend in two clicks — pick a
// provider, paste a key (with "Create key…" opening the right page), Connect.
// The connect verifies the endpoint live and auto-picks a fast model, so
// "connected" always means "ready to generate". GitGrove ships no AI service:
// the key is the user's, stored in the OS keychain, and diffs only ever go to
// the endpoint configured here. styles: features/ai.css (.ai-*)

import type { AiStatus } from '@shared/types'
import { type FormEvent, useState } from 'react'
import { ConfirmDialog } from '@/components/common/Dialog'
import {
  AI_PROVIDER_CHOICES,
  type AiProviderChoice,
  aiErrorCopy,
  aiProviderLabel,
  useAiStatus
} from '@/lib/ai'
import { Icon } from '@/lib/icons'

export function AiPane() {
  const status = useAiStatus()
  const [choice, setChoice] = useState<AiProviderChoice | null>(null)
  // True right after a connect completes, for the one-time "try it" hint.
  const [justConnected, setJustConnected] = useState(false)

  if (status === undefined) {
    return (
      <div className="center-state" style={{ padding: 24 }}>
        <div className="spinner" />
      </div>
    )
  }

  if (status !== null) {
    return (
      <ConnectedCard
        status={status}
        justConnected={justConnected}
        onDisconnected={() => {
          setJustConnected(false)
          setChoice(null)
        }}
      />
    )
  }

  if (choice) {
    return (
      <ConnectForm
        choice={choice}
        onBack={() => setChoice(null)}
        onConnected={() => setJustConnected(true)}
      />
    )
  }

  return (
    <>
      <p className="trust__body" style={{ marginBottom: 10 }}>
        Bring your own AI — GitGrove writes commit messages and more, using your key, sent only to
        the provider you pick. Nothing is shared with anyone else.
      </p>
      <div className="acct-flow">
        {AI_PROVIDER_CHOICES.map((c) => (
          <button key={c.id} type="button" className="acct-choice" onClick={() => setChoice(c)}>
            <Icon.Sparkle size={18} />
            <span className="acct-choice__main">
              <span className="acct-choice__title">{c.label}</span>
              <span className="acct-choice__sub">{c.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

/** Step two: endpoint/key form → Connect (verifies live, then saves). */
function ConnectForm({
  choice,
  onBack,
  onConnected
}: {
  choice: AiProviderChoice
  onBack: () => void
  onConnected: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canConnect = !busy && (choice.keyOptional || apiKey.trim().length > 0)

  const connect = async (e: FormEvent) => {
    e.preventDefault()
    if (!canConnect) return
    setBusy(true)
    setError(null)
    const result = await window.gitgrove.aiConnect({
      provider: choice.id,
      baseUrl: baseUrl.trim() || (choice.id === 'ollama' ? choice.baseUrlPlaceholder : undefined),
      apiKey: apiKey.trim() || undefined
    })
    setBusy(false)
    if (result.ok) onConnected()
    else setError(aiErrorCopy(result.code, result.detail))
  }

  return (
    <form className="acct-flow" onSubmit={connect}>
      <p className="trust__body">
        {choice.id === 'ollama' ? (
          <>
            Connect the Ollama running on this machine — free, private, no key. GitGrove picks an
            installed model automatically.
          </>
        ) : choice.needsBaseUrl ? (
          <>Point GitGrove at your OpenAI-compatible endpoint.</>
        ) : (
          <>
            Paste a <strong>{choice.label}</strong> key — GitGrove verifies it and picks a fast
            model automatically. Your key is stored in the system keychain, never shared.
          </>
        )}
      </p>
      {choice.needsBaseUrl && (
        <div className="dlg-field">
          <label htmlFor="ai-base-url">Endpoint URL</label>
          <input
            id="ai-base-url"
            autoFocus
            autoComplete="off"
            placeholder={choice.baseUrlPlaceholder}
            value={baseUrl}
            disabled={busy}
            onChange={(e) => {
              setError(null)
              setBaseUrl(e.target.value)
            }}
          />
        </div>
      )}
      {choice.needsKey && (
        <div className="dlg-field">
          <label htmlFor="ai-key">API key{choice.keyOptional ? ' (if required)' : ''}</label>
          <div className="dlg-pickrow">
            <input
              id="ai-key"
              type="password"
              autoFocus={!choice.needsBaseUrl}
              autoComplete="off"
              placeholder="sk-…"
              value={apiKey}
              disabled={busy}
              onChange={(e) => {
                setError(null)
                setApiKey(e.target.value)
              }}
            />
            {choice.keyUrl && (
              <button
                type="button"
                className="btn-ghost btn-ghost--sm"
                onClick={() => window.gitgrove.openExternal(choice.keyUrl as string)}
              >
                Create key… <Icon.External size={12} />
              </button>
            )}
          </div>
        </div>
      )}
      {error && <p className="dlg-error">{error}</p>}
      <div className="trust__actions">
        <button type="button" className="btn-ghost btn-ghost--sm" disabled={busy} onClick={onBack}>
          Back
        </button>
        <button type="submit" className="btn-primary btn-primary--sm" disabled={!canConnect}>
          {busy && <span className="about__spinner" aria-hidden />}
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
    </form>
  )
}

/** The connected state: one calm card — model picker, disconnect, privacy note. */
function ConnectedCard({
  status,
  justConnected,
  onDisconnected
}: {
  status: AiStatus
  justConnected: boolean
  onDisconnected: () => void
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  return (
    <>
      {justConnected && (
        <p className="ai-connected-hint">
          <Icon.Check size={14} /> Connected — try the <Icon.Sparkle size={13} /> button in the
          commit box.
        </p>
      )}
      <div className="wt-list">
        <div className="wt-item">
          <span className="ai-provider-badge" aria-hidden>
            <Icon.Sparkle size={18} />
          </span>
          <div className="wt-item__main">
            <span className="wt-item__branch">
              {aiProviderLabel(status.provider)}
              {!status.persisted && (
                <span
                  className="tag tag--current"
                  data-tip="No OS keyring was available, so this connection lasts until GitGrove quits."
                >
                  this session only
                </span>
              )}
            </span>
            <span className="wt-item__path">{status.baseUrl ?? 'AI features enabled'}</span>
          </div>
          <div className="wt-item__actions">
            <button
              className="section-head__action"
              data-tip="Forget this backend and its key"
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect
            </button>
          </div>
        </div>
      </div>
      <div className="dlg-field" style={{ marginTop: 12 }}>
        <label htmlFor="ai-model">Model</label>
        <select
          id="ai-model"
          className="ai-select"
          value={status.model}
          onChange={(e) => window.gitgrove.aiSetModel(e.target.value)}
        >
          {status.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <p className="trust__note" style={{ marginTop: 10 }}>
        Your key stays on this machine{status.persisted ? ', encrypted in the system keychain' : ''}
        . Diffs and commit history snippets are sent only to this endpoint, only when you ask for a
        generation.
      </p>

      {confirmDisconnect && (
        <ConfirmDialog
          title="Disconnect AI?"
          body={
            <>
              GitGrove forgets the {aiProviderLabel(status.provider)} connection and its key. AI
              buttons stay visible and will offer to set it up again.
            </>
          }
          confirmLabel="Disconnect"
          onConfirm={async () => {
            setConfirmDisconnect(false)
            await window.gitgrove.aiDisconnect()
            onDisconnected()
          }}
          onCancel={() => setConfirmDisconnect(false)}
        />
      )}
    </>
  )
}
