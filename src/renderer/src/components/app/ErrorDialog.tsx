// styles: features/dialogs.css (.errdlg-*)
// The calm home for failures. Git errors used to flash by as a transient toast
// — too short to read, too small to hold a multi-line stderr dump, awkward to
// select. This is a proper modal instead: the full message sits in a
// scrollable, selectable block that never truncates, with one-click Copy and a
// Report-an-Issue button that pre-fills a GitHub issue with the error + the
// build environment, so reporting a bug is a single click rather than a
// copy-paste chore.

import type { AppInfo } from '@shared/types'
import { useState } from 'react'
import { DialogShell } from '@/components/common/Dialog'
import { Icon } from '@/lib/icons'

interface Props {
  message: string
  info: AppInfo | null
  onClose: () => void
}

export function ErrorDialog({ message, info, onClose }: Props) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    window.gitgrove.clipboardWrite(message)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const report = () => {
    window.gitgrove.openExternal(issueUrl(message, info))
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

      {/* Read-only, monospace, scrollable — the whole stderr, however long, stays
          selectable and never gets clipped. */}
      <pre className="errdlg__detail" tabIndex={0}>
        {message}
      </pre>

      <div className="errdlg__actions">
        <button className="btn-ghost btn-ghost--sm" onClick={report}>
          <Icon.Github size={14} /> Report an Issue
        </button>
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
