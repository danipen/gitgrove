// "Explain this commit" — a ✨ Explain chip that streams a short
// what/why/watch-out note into a dismissible card. Shared by every commit view
// (History summary, Graph detail) so a commit reads the same wherever the user
// meets it. Commits are immutable, so main caches answers per hash — reopening
// is instant and free. Unconfigured, the chip opens the shared setup teaser.
//
// Shaped as a hook returning two pieces because the trigger and the answer
// live on different rows of the host's grid: the chip sits anchored in the
// commit meta line (author · date · sha · ✨ Explain — never floating alone in
// whitespace), the card appears under the commit body. Pass null to render
// neither (hosts without a repo path / settings access).
// styles: features/ai.css (.ai-chip, .ai-note)

import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useAiGeneration, useAiStatus } from '@/lib/ai'
import { Icon } from '@/lib/icons'
import { AiTeaserPopover } from './AiTeaserPopover'

export interface AiExplainArgs {
  repoPath: string
  hash: string
  /** Open Settings → AI (the teaser's one button). */
  onSetupAi: () => void
}

export function useAiExplainCommit(args: AiExplainArgs | null): {
  /** The ✨ Explain chip (a toggle once open) — place it in the meta row. */
  trigger: ReactNode
  /** The streamed explanation card, or null while closed. */
  card: ReactNode
} {
  const status = useAiStatus()
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [teaserOpen, setTeaserOpen] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const explanation = useAiGeneration((e) => setFailure(e instanceof Error ? e.message : String(e)))

  const hash = args?.hash
  // Some hosts remount per commit (keyed by hash), some don't (the Graph's
  // detail pane) — either way, a different commit invalidates what's shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hash is the intentional reset trigger
  useEffect(() => {
    setOpen(false)
    setFailure(null)
    explanation.reset()
  }, [hash])

  if (!args) return { trigger: null, card: null }
  const { repoPath, onSetupAi } = args

  const explain = () => {
    setFailure(null)
    setOpen(true)
    explanation.run((requestId) =>
      window.gitgrove.aiExplainCommit(repoPath, { requestId, hash: args.hash })
    )
  }

  const close = () => {
    if (explanation.generating) explanation.stop()
    setOpen(false)
  }

  const trigger = (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`ai-chip${open ? ' is-active' : ''}`}
        aria-pressed={open}
        data-tip={
          status
            ? open
              ? 'Hide the explanation'
              : undefined
            : 'Explain this commit with AI — click to set up'
        }
        onClick={() => {
          if (!status) setTeaserOpen(true)
          else if (open) close()
          else explain()
        }}
      >
        <Icon.Sparkle size={12} /> Explain
      </button>
      <AiTeaserPopover
        anchor={chipRef.current}
        open={teaserOpen}
        onClose={() => setTeaserOpen(false)}
        title="Explain this commit with AI"
        body="What changed, why it likely changed and what to watch out for — from the commit itself."
        onSetup={onSetupAi}
      />
    </>
  )

  const card = open ? (
    <div className="ai-note">
      <div className="ai-note__head">
        <Icon.Sparkle size={13} />
        <span className="ai-note__title">AI explanation</span>
        {explanation.generating && <span className="ai-btn__spinner" aria-hidden />}
        {failure && !explanation.generating && (
          <button
            type="button"
            className="ai-note__action"
            aria-label="Try again"
            data-tip="Try again"
            onClick={explain}
          >
            <Icon.Refresh size={12} />
          </button>
        )}
        <button
          type="button"
          className="ai-note__action"
          aria-label="Dismiss explanation"
          onClick={close}
        >
          <Icon.Close size={12} />
        </button>
      </div>
      <AiNoteBody text={explanation.text} failure={failure} streaming={explanation.generating} />
    </div>
  ) : null

  return { trigger, card }
}

/**
 * The streamed answer as real paragraphs. Models separate thoughts with blank
 * lines; rendering the raw text pre-wrap would turn each into a full empty
 * line — too airy to read (single newlines, e.g. "- " bullets, stay literal
 * inside a paragraph). Exported for the error dialog's note, so every AI
 * answer in the app reads with the same rhythm.
 */
export function AiNoteBody({
  text,
  failure,
  streaming
}: {
  text: string
  failure: string | null
  streaming: boolean
}) {
  if (failure) return <div className="ai-note__body ai-note__body--error">{failure}</div>
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  const last = paragraphs.length - 1
  return (
    <div className="ai-note__body">
      {paragraphs.map((p, i) => (
        // Order is stable while streaming (text only appends) — index keys are safe.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream
        <p key={i}>
          {p}
          {streaming && i === last && <span className="ai-note__caret" aria-hidden />}
        </p>
      ))}
      {/* Nothing arrived yet: the caret alone marks the forming answer. */}
      {streaming && paragraphs.length === 0 && (
        <p>
          <span className="ai-note__caret" aria-hidden />
        </p>
      )}
    </div>
  )
}
