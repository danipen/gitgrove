// Clone dialog: pick a repository to clone from a connected GitHub.com /
// Enterprise account (browse + filter your repos), or paste any URL. When the
// account a tab needs isn't connected yet, the tab offers to connect it right
// here — no detour through Settings. The destination is prefilled with a
// sensible base folder (remembered across clones) and the repo's own name, so
// the common case is "pick a repo, press Clone". Live progress comes from
// `git clone --progress`; the new repo opens on success.
//
// styles: features/dialogs.css (.clone-tabs, .clone-dest, .clone-progress)

import { isGitHubDotCom } from '@shared/git-hosts'
import type { CloneProgress, ConnectedAccount, RemoteRepo } from '@shared/types'
import { useEffect, useState } from 'react'
import { DialogShell } from '@/components/common/Dialog'
import { AddAccountFlow } from '@/components/settings/AddAccountFlow'
import { prettyPath } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { CloneRepoPicker } from './CloneRepoPicker'

interface Props {
  onDone: (repoPath: string) => void
  onCancel: () => void
}

type Tab = 'github' | 'enterprise' | 'url'

/** The repo folder a URL would clone into — mirrors git's own dest naming. */
function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? ''
  return last.replace(/\.git$/, '')
}

export function CloneDialog({ onDone, onCancel }: Props) {
  const [tab, setTab] = useState<Tab>('github')
  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [enterpriseId, setEnterpriseId] = useState<string | null>(null)
  const [repo, setRepo] = useState<RemoteRepo | null>(null)
  const [url, setUrl] = useState('')
  const [dir, setDir] = useState<string | null>(null)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => window.gitgrove.onCloneProgress(setProgress), [])
  useEffect(() => {
    const reload = () => window.gitgrove.listAccounts().then(setAccounts)
    reload()
    return window.gitgrove.onAccountsChanged(reload)
  }, [])
  useEffect(() => {
    window.gitgrove.defaultCloneDir().then((d) => setDir((prev) => prev ?? d))
  }, [])

  const githubAccount = accounts?.find((a) => isGitHubDotCom(a.host)) ?? null
  const enterpriseAccounts = accounts?.filter((a) => !isGitHubDotCom(a.host)) ?? []
  const enterprise =
    enterpriseAccounts.find((a) => a.id === enterpriseId) ?? enterpriseAccounts[0] ?? null

  // What pressing Clone would fetch, and the folder it'd land in.
  const targetUrl = tab === 'url' ? url.trim() : (repo?.cloneUrl ?? '')
  const targetName = tab === 'url' ? repoNameFromUrl(url) : (repo?.name ?? '')
  const canClone = !!targetUrl && !!dir && !cloning

  const switchTab = (next: Tab) => {
    setTab(next)
    setConnecting(false)
    setRepo(null)
    setError(null)
  }

  const onConnected = (account: ConnectedAccount) => {
    setConnecting(false)
    window.gitgrove.listAccounts().then(setAccounts)
    if (!isGitHubDotCom(account.host)) setEnterpriseId(account.id)
  }

  const pickDir = async () => {
    const picked = await window.gitgrove.pickDirectory('Clone into folder')
    if (picked) setDir(picked)
  }

  const start = async () => {
    if (!canClone || !dir) return
    setCloning(true)
    setError(null)
    setProgress(null)
    try {
      const repoPath = await window.gitgrove.cloneRepo(targetUrl, dir)
      onDone(repoPath)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setCloning(false)
    }
  }

  const connectCta = (provider: 'github' | 'enterprise') => (
    <div className="clone-picker__state">
      {provider === 'github' ? <Icon.Github size={30} /> : <Icon.Repo size={30} />}
      <p className="trust__body">
        {provider === 'github'
          ? 'Connect your GitHub account to browse and clone your repositories.'
          : 'Connect your GitHub Enterprise server to browse and clone its repositories.'}
      </p>
      <button className="btn-primary btn-primary--sm" onClick={() => setConnecting(true)}>
        {provider === 'github' ? (
          <>
            <Icon.Github size={14} /> Sign in with GitHub
          </>
        ) : (
          'Connect GitHub Enterprise'
        )}
      </button>
    </div>
  )

  const source = () => {
    if (tab === 'url') {
      return (
        <div className="dlg-field">
          <label htmlFor="clone-url">Repository URL</label>
          <input
            id="clone-url"
            autoFocus
            placeholder="https://github.com/owner/repo.git or git@host:owner/repo.git"
            value={url}
            disabled={cloning}
            onChange={(e) => {
              setError(null)
              setUrl(e.target.value)
            }}
            onKeyDown={(e) => e.key === 'Enter' && start()}
          />
        </div>
      )
    }
    if (tab === 'github') {
      if (!githubAccount) return connectCta('github')
      return (
        <CloneRepoPicker
          account={githubAccount}
          selectedId={repo?.id ?? null}
          onSelect={setRepo}
          disabled={cloning}
        />
      )
    }
    // enterprise
    if (!enterprise) return connectCta('enterprise')
    return (
      <>
        {enterpriseAccounts.length > 1 && (
          <div className="segmented clone-acct">
            {enterpriseAccounts.map((a) => (
              <button
                key={a.id}
                className={a.id === enterprise.id ? 'is-active' : ''}
                onClick={() => {
                  setEnterpriseId(a.id)
                  setRepo(null)
                }}
              >
                {a.host}
              </button>
            ))}
          </div>
        )}
        <CloneRepoPicker
          account={enterprise}
          selectedId={repo?.id ?? null}
          onSelect={setRepo}
          disabled={cloning}
        />
      </>
    )
  }

  return (
    <DialogShell
      title="Clone repository"
      icon={<Icon.Download size={22} />}
      busy={cloning}
      onClose={onCancel}
      width={540}
    >
      <div className="segmented clone-tabs">
        <button className={tab === 'github' ? 'is-active' : ''} onClick={() => switchTab('github')}>
          <Icon.Github size={14} /> GitHub.com
        </button>
        <button
          className={tab === 'enterprise' ? 'is-active' : ''}
          onClick={() => switchTab('enterprise')}
        >
          <Icon.Repo size={14} /> Enterprise
        </button>
        <button className={tab === 'url' ? 'is-active' : ''} onClick={() => switchTab('url')}>
          <Icon.External size={14} /> URL
        </button>
      </div>

      {connecting && tab !== 'url' ? (
        <AddAccountFlow
          start={tab === 'github' ? 'github' : 'enterprise'}
          onDone={onConnected}
          onCancel={() => setConnecting(false)}
        />
      ) : (
        <>
          {source()}

          <div className="dlg-field">
            <label htmlFor="clone-dir">Clone into</label>
            <div className="dlg-pickrow">
              <input
                id="clone-dir"
                readOnly
                placeholder="Choose a parent folder…"
                value={dir ? prettyPath(dir) : ''}
                onClick={pickDir}
              />
              <button className="btn-ghost btn-ghost--sm" onClick={pickDir} disabled={cloning}>
                <Icon.Folder size={14} /> Browse
              </button>
            </div>
            {dir && targetName && (
              <p className="clone-dest">
                Into <code>{`${prettyPath(dir)}/${targetName}`}</code>
              </p>
            )}
          </div>

          {cloning && (
            <div className="clone-progress">
              <div className="clone-progress__bar">
                <div
                  className="clone-progress__fill"
                  style={{ width: `${Math.max(2, progress?.percent ?? 2)}%` }}
                />
              </div>
              <span className="clone-progress__label">
                {progress ? `${progress.phase}… ${progress.percent}%` : 'Starting clone…'}
              </span>
            </div>
          )}
          {error && <p className="dlg-error">{error}</p>}

          <div className="trust__actions">
            <button className="btn-ghost btn-ghost--sm" onClick={onCancel} disabled={cloning}>
              Cancel
            </button>
            <button className="btn-primary btn-primary--sm" onClick={start} disabled={!canClone}>
              {cloning && <span className="about__spinner" aria-hidden />}
              {cloning ? 'Cloning…' : 'Clone'}
            </button>
          </div>
        </>
      )}
    </DialogShell>
  )
}
