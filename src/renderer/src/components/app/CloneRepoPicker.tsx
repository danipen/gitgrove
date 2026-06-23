// The repository browser inside the clone dialog's GitHub.com / Enterprise
// tabs: a filter box over the connected account's repositories, grouped by
// owner with the user's own repos first. Selecting a repo hands its clone URL
// back up to the dialog. Repos stream in page by page (most-recent first) so
// the first ones show within a second on accounts with hundreds of repos,
// rather than blocking on the whole walk; a "Loading more…" footer shows while
// the rest arrive. Completed lists are cached for the app session so flipping
// between tabs (or reopening the dialog) is instant; refresh forces a re-fetch.
//
// styles: features/dialogs.css (.clone-picker, .clone-repo)

import type { ConnectedAccount, RemoteRepo } from '@shared/types'
import { useEffect, useState } from 'react'
import { ClearButton } from '@/components/common/ClearButton'
import { filterTerms, groupReposByOwner } from '@/lib/clone-repos'
import { highlightTerms } from '@/lib/highlight'
import { Icon } from '@/lib/icons'

interface Props {
  account: ConnectedAccount
  selectedId: string | null
  onSelect: (repo: RemoteRepo) => void
  disabled?: boolean
}

// Session cache keyed by account id — the API list rarely changes mid-session,
// and a fresh multi-page walk per tab switch would feel sluggish. Only complete
// lists are cached; refresh clears the entry to pull a fresh one on demand.
const repoCache = new Map<string, RemoteRepo[]>()

export function CloneRepoPicker({ account, selectedId, onSelect, disabled }: Props) {
  const [repos, setRepos] = useState<RemoteRepo[]>(() => repoCache.get(account.id) ?? [])
  const [loading, setLoading] = useState(!repoCache.has(account.id))
  const [error, setError] = useState(false)
  const [filter, setFilter] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // reloadKey is an intentional re-run trigger (refresh), not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-fetches on demand
  useEffect(() => {
    const cached = repoCache.get(account.id)
    if (cached) {
      setRepos(cached)
      setLoading(false)
      setError(false)
      return
    }
    let cancelled = false
    const seen = new Set<string>()
    setRepos([])
    setLoading(true)
    setError(false)
    // Append each page as it streams in (deduped) so results appear fast.
    const off = window.gitgrove.onAccountReposPage((page) => {
      if (cancelled || page.accountId !== account.id) return
      const fresh = page.repos.filter((r) => !seen.has(r.id))
      if (fresh.length === 0) return
      for (const r of fresh) seen.add(r.id)
      setRepos((prev) => [...prev, ...fresh])
    })
    window.gitgrove
      .listAccountRepos(account.id)
      .then((list) => {
        if (cancelled) return
        repoCache.set(account.id, list)
        setRepos(list) // canonical, complete, sorted list supersedes the stream
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setError(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
      off()
    }
  }, [account.id, reloadKey])

  const refresh = () => {
    repoCache.delete(account.id)
    setReloadKey((k) => k + 1)
  }

  const groups = groupReposByOwner(repos, account.login, filter)
  const terms = filterTerms(filter)
  // Loading and error states render *inside* the fixed-size list so the header
  // (filter + refresh) and the dialog's size stay put — a refresh just swaps
  // the list's contents, never the whole panel.
  const blankError = error && repos.length === 0
  const blankLoading = loading && repos.length === 0

  return (
    <div className="clone-picker">
      <div className="clone-picker__head">
        <div className="clone-picker__search">
          <Icon.Search size={14} />
          <input
            autoFocus
            placeholder="Filter your repositories"
            value={filter}
            disabled={disabled}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter !== '' && !disabled && (
            <ClearButton label="Clear filter" onClear={() => setFilter('')} />
          )}
        </div>
        <button
          className="btn-ghost btn-ghost--sm clone-picker__refresh"
          data-tip="Refresh list"
          disabled={disabled || blankLoading}
          onClick={refresh}
        >
          <Icon.Refresh size={14} />
        </button>
      </div>
      <div className="clone-picker__list">
        {blankError ? (
          <div className="clone-picker__state">
            <p className="trust__body">Couldn’t load your repositories from {account.host}.</p>
            <button className="btn-ghost btn-ghost--sm" onClick={refresh}>
              <Icon.Refresh size={14} /> Try again
            </button>
          </div>
        ) : blankLoading ? (
          <div className="clone-picker__state">
            <span className="spinner" />
            <span>Loading your repositories…</span>
          </div>
        ) : groups.length === 0 ? (
          <p className="clone-picker__empty">No repositories match.</p>
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
                      {/* One span so highlight fragments flow inline, not as flex items. */}
                      <span className="clone-repo__name-text">
                        {highlightTerms(repo.name, terms)}
                      </span>
                      {repo.private && <Icon.Lock size={11} className="clone-repo__lock" />}
                      {repo.fork && <span className="clone-repo__tag">fork</span>}
                      {repo.archived && <span className="clone-repo__tag">archived</span>}
                    </span>
                    <span
                      className={`clone-repo__desc${repo.description ? '' : ' clone-repo__desc--empty'}`}
                    >
                      {repo.description
                        ? highlightTerms(repo.description, terms)
                        : 'No description'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      {loading && repos.length > 0 && (
        <div className="clone-picker__more">
          <span className="spinner spinner--sm" /> Loading more…
        </div>
      )}
      {error && !loading && repos.length > 0 && (
        <div className="clone-picker__more">
          Couldn’t load all repositories.{' '}
          <button className="link-button" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
    </div>
  )
}
