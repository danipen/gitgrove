// The repository browser inside the clone dialog's GitHub.com / Enterprise
// tabs: a filter box over the connected account's repositories, grouped by
// owner with the user's own repos first. Selecting a repo hands its clone URL
// back up to the dialog. Fetched lists are cached for the app session so
// flipping between tabs (or reopening the dialog) is instant; the refresh
// button forces a re-fetch when something was just created on the host.
//
// styles: features/dialogs.css (.clone-picker, .clone-repo)

import type { ConnectedAccount, RemoteRepo } from '@shared/types'
import { useEffect, useState } from 'react'
import { groupReposByOwner } from '@/lib/clone-repos'
import { Icon } from '@/lib/icons'

interface Props {
  account: ConnectedAccount
  selectedId: string | null
  onSelect: (repo: RemoteRepo) => void
  disabled?: boolean
}

// Session cache keyed by account id — the API list rarely changes mid-session,
// and a network round-trip per tab switch would feel sluggish. Refresh clears
// the relevant entry to pull a fresh list on demand.
const repoCache = new Map<string, RemoteRepo[]>()

export function CloneRepoPicker({ account, selectedId, onSelect, disabled }: Props) {
  const [repos, setRepos] = useState<RemoteRepo[] | null>(() => repoCache.get(account.id) ?? null)
  const [error, setError] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    const cached = repoCache.get(account.id)
    if (cached) {
      setRepos(cached)
      setError(false)
      return
    }
    setRepos(null)
    setError(false)
    window.gitgrove
      .listAccountRepos(account.id)
      .then((list) => {
        if (cancelled) return
        repoCache.set(account.id, list)
        setRepos(list)
      })
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [account.id])

  const refresh = () => {
    repoCache.delete(account.id)
    setRepos(null)
    setError(false)
    window.gitgrove
      .listAccountRepos(account.id)
      .then((list) => {
        repoCache.set(account.id, list)
        setRepos(list)
      })
      .catch(() => setError(true))
  }

  if (error) {
    return (
      <div className="clone-picker__state">
        <p className="trust__body">Couldn’t load your repositories from {account.host}.</p>
        <button className="btn-ghost btn-ghost--sm" onClick={refresh}>
          <Icon.Refresh size={14} /> Try again
        </button>
      </div>
    )
  }

  if (!repos) {
    return (
      <div className="clone-picker__state">
        <span className="spinner" />
        <span>Loading your repositories…</span>
      </div>
    )
  }

  const groups = groupReposByOwner(repos, account.login, filter)

  return (
    <div className="clone-picker">
      <div className="clone-picker__search">
        <Icon.Search size={14} />
        <input
          autoFocus
          placeholder="Filter your repositories"
          value={filter}
          disabled={disabled}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="icon-btn" data-tip="Refresh list" disabled={disabled} onClick={refresh}>
          <Icon.Refresh size={14} />
        </button>
      </div>
      <div className="clone-picker__list">
        {groups.length === 0 ? (
          <p className="clone-picker__empty">
            {repos.length === 0 ? 'No repositories on this account.' : 'No repositories match.'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.owner} className="clone-picker__group">
              <div className="clone-picker__owner">
                {group.owner === account.login ? 'Your repositories' : group.owner}
              </div>
              {group.repos.map((repo) => (
                <button
                  key={repo.id}
                  type="button"
                  className={`clone-repo${repo.id === selectedId ? ' is-selected' : ''}`}
                  disabled={disabled}
                  onClick={() => onSelect(repo)}
                >
                  <Icon.Repo size={15} className="clone-repo__icon" />
                  <span className="clone-repo__main">
                    <span className="clone-repo__name">
                      {repo.name}
                      {repo.private && <Icon.Lock size={11} className="clone-repo__lock" />}
                      {repo.fork && <span className="clone-repo__tag">fork</span>}
                      {repo.archived && <span className="clone-repo__tag">archived</span>}
                    </span>
                    {repo.description && (
                      <span className="clone-repo__desc">{repo.description}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
