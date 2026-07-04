// "Explain this commit" — one quiet ✨ Explain affordance that streams a
// short what/why/watch-out note into a dismissible card. Shared by every
// commit view (History summary, Graph detail) so a commit reads the same
// wherever the user meets it. Commits are immutable, so main caches answers
// per hash — reopening is instant and free. Unconfigured, the trigger opens
// the shared setup teaser. styles: features/ai.css (.ai-explain, .ai-note)

import { useEffect, useRef, useState } from 'react'
import { useAiGeneration, useAiStatus } from '@/lib/ai'
import { Icon } from '@/lib/icons'
import { AiTeaserPopover } from './AiTeaserPopover'

interface Props {
  repoPath: string
  hash: string
  /** Open Settings → AI (the teaser's one button). */
  onSetupAi: () => void
}

export function AiExplainCommit({ repoPath, hash, onSetupAi }: Props) {
  const status = useAiStatus()
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [teaserOpen, setTeaserOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const explanation = useAiGeneration((e) =>
    setFailure(e instanceof Error ? e.message : String(e))
  )

  // Some hosts remount per commit (keyed by hash), some don't (the Graph's
  // detail pane) — either way, a different commit invalidates what's shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hash is the intentional reset trigger
  useEffect(() => {
    setOpen(false)
    setFailure(null)
    explanation.reset()
  }, [hash])

  const explain = () => {
    setFailure(null)
    setOpen(true)
    explanation.run((requestId) => window.gitgrove.aiExplainCommit(repoPath, { requestId, hash }))
  }

  const close = () => {
    if (explanation.generating) explanation.stop()
    setOpen(false)
  }

  if (!open) {
    return (
      <div className="ai-explain">
        <button
          ref={triggerRef}
          type="button"
          className="ai-explain__trigger"
          data-tip={status ? undefined : 'Explain this commit with AI — click to set up'}
          onClick={() => {
            if (status) explain()
            else setTeaserOpen(true)
          }}
        >
          <Icon.Sparkle size={13} /> Explain
        </button>
        <AiTeaserPopover
          anchor={triggerRef.current}
          open={teaserOpen}
          onClose={() => setTeaserOpen(false)}
          title="Explain this commit with AI"
          body="What changed, why it likely changed and what to watch out for — from the commit itself."
          onSetup={onSetupAi}
        />
      </div>
    )
  }

  return (
    <div className="ai-note">
      <div className="ai-note__head">
        <Icon.Sparkle size={13} />
        <span className="ai-note__title">AI explanation</span>
        {explanation.generating && <span className="ai-btn__spinner" aria-hidden />}
        {failure && !explanation.generating && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Try again"
            data-tip="Try again"
            onClick={explain}
          >
            <Icon.Refresh size={12} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn ai-note__close"
          aria-label="Dismiss explanation"
          onClick={close}
        >
          <Icon.Close size={12} />
        </button>
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
  )
}
