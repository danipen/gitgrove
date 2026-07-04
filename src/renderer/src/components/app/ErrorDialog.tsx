// styles: features/dialogs.css (.errdlg-*), features/ai.css (.ai-note)
// The calm home for failures. Git errors used to flash by as a transient toast
// — too short to read, too small to hold a multi-line stderr dump, awkward to
// select. This is a proper modal instead: the full message sits in a
// scrollable, selectable block that never truncates, with one-click Copy and a
// Report-an-Issue button that pre-fills a GitHub issue with the error + the
// build environment, so reporting a bug is a single click rather than a
// copy-paste chore.
//
// The ✨ Explain button turns git's words ("non-fast-forward", "unrelated
// histories") into one plain-English sentence plus the next step, streamed
// into a calm note above the raw error. Unconfigured, it opens the setup
// teaser — the moment of a cryptic failure is exactly when AI sells itself.

import type { AppInfo } from '@shared/types'
import { useRef, useState } from 'react'
import { AiTeaserPopover } from '@/components/common/AiTeaserPopover'
import { DialogShell } from '@/components/common/Dialog'
import { useAiGeneration, useAiStatus } from '@/lib/ai'
import { Icon } from '@/lib/icons'

/** The repo situation the explainer sends along — from state the renderer
 *  already holds, never fresh git calls (see explain-error.ts for why). */
export interface ErrorAiContext {
  repoPath: string | null
  branch?: string
  upstream?: string | null
  ahead?: number
  behind?: number
  opState?: string
  /** Open Settings → AI (the teaser's one button). */
  onSetupAi: () => void
}

interface Props {
  message: string
  info: AppInfo | null
  ai: ErrorAiContext
  onClose: () => void
}

export function ErrorDialog({ message, info, ai, onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const aiStatus = useAiStatus()
  const [failure, setFailure] = useState<string | null>(null)
  const [teaserOpen, setTeaserOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const explainRef = useRef<HTMLButtonElement>(null)
  const explanation = useAiGeneration((e) =>
    setFailure(e instanceof Error ? e.message : String(e))
  )

  const copy = () => {
    window.gitgrove.clipboardWrite(message)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const report = () => {
    window.gitgrove.openExternal(issueUrl(message, info))
  }

  const explain = () => {
    if (!aiStatus) {
      setTeaserOpen(true)
      return
    }
    if (explanation.generating) return
    setFailure(null)
    setNoteOpen(true)
    explanation.run((requestId) =>
      window.gitgrove.aiExplainError(ai.repoPath, {
        requestId,
        error: message,
        branch: ai.branch,
        upstream: ai.upstream,
        ahead: ai.ahead,
        behind: ai.behind,
        opState: ai.opState
      })
    )
  }

  return (
    <DialogShell
      title="Something went wrong"
      danger
      icon={<Icon.Alert size={22} />}
      width={560}
      onClose={onClose}
    >
      <p className="trust__body">
        The operation didn’t complete. Here’s exactly what git reported — copy it or send it our way
        and we’ll take a look.
      </p>

      {noteOpen && (
        <div className="ai-note errdlg__ai-note">
          <div className="ai-note__head">
            <Icon.Sparkle size={13} />
            <span className="ai-note__title">What this means</span>
            {explanation.generating && <span className="ai-btn__spinner" aria-hidden />}
          </div>
          {failure ? (
            <p className="ai-note__body ai-note__body--error">{failure}</p>
          ) : (
            <p className="ai-note__body">
              {explanation.text}
              {explanation.generating && <span className="ai-note__caret" aria-hidden />}
            </p>
          )}
        </div>
      )}

      {/* Read-only, monospace, scrollable — the whole stderr, however long, stays
          selectable and never gets clipped. */}
      <pre className="errdlg__detail" tabIndex={0}>
        {message}
      </pre>

      <div className="errdlg__actions">
        <div className="errdlg__actions-left">
          {/* Hidden once the note streams; back for a retry when it failed. */}
          {(!noteOpen || (failure && !explanation.generating)) && (
            <button
              ref={explainRef}
              className="btn-ghost btn-ghost--sm"
              data-tip={aiStatus ? undefined : 'Explain this error with AI — click to set up'}
              onClick={explain}
            >
              <Icon.Sparkle size={14} /> Explain
            </button>
          )}
          <button className="btn-ghost btn-ghost--sm" onClick={report}>
            <Icon.Github size={14} /> Report an Issue
          </button>
        </div>
        <div className="errdlg__actions-right">
          <button className="btn-ghost btn-ghost--sm" onClick={copy}>
            {copied ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn-primary btn-primary--sm" onClick={onClose} autoFocus>
            Dismiss
          </button>
        </div>
      </div>

      <AiTeaserPopover
        anchor={explainRef.current}
        open={teaserOpen}
        onClose={() => setTeaserOpen(false)}
        title="Explain this error with AI"
        body="Git's message becomes one plain sentence plus the most likely next step."
        onSetup={() => {
          onClose()
          ai.onSetupAi()
        }}
      />
    </DialogShell>
  )
}

/** GitHub's issue body has a generous but finite URL budget; keep the embedded
 *  error from blowing past it (the full text is one Copy click away anyway). */
const MAX_DETAIL = 4000

/** Build a GitHub "new issue" URL with the error and the build environment
 *  pre-filled, so the user reports a bug without hand-assembling any of it. */
function issueUrl(message: string, info: AppInfo | null): string {
  const base = `${info?.repoUrl ?? 'https://github.com/danipen/gitgrove'}/issues/new`
  const firstLine = message.split('\n', 1)[0]?.trim() ?? 'Error'
  const title = `Error: ${firstLine.slice(0, 90)}`
  const detail =
    message.length > MAX_DETAIL ? `${message.slice(0, MAX_DETAIL)}\n… (truncated)` : message

  const env = info
    ? [
        `- GitGrove ${info.version}${info.dev ? ' (dev)' : ''}`,
        `- ${info.platform} · ${info.arch}`,
        `- Electron ${info.electron} · Chromium ${info.chrome}`
      ].join('\n')
    : '- (unknown)'

  const body = [
    '**What were you doing when this happened?**',
    '',
    '<!-- A short description helps a lot. -->',
    '',
    '**Error details**',
    '',
    '```',
    detail,
    '```',
    '',
    '**Environment**',
    '',
    env
  ].join('\n')

  return `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}
