// The composer's AI cluster (top-right of the summary field): a ✨ button
// that streams a generated commit/stash message into the fields, plus a caret
// opening the style popover — length, tone, emojis, regenerate. The button is
// ALWAYS visible: with no backend connected it opens the setup teaser instead
// of generating, so the feature explains itself exactly where it's useful and
// setup is one click away (Settings → AI). styles: features/ai.css (.ai-*),
// positioning in changes.css (.composer__ai)

import type { AiCommitOptions, ChangedFile } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { AiTeaserPopover } from '@/components/common/AiTeaserPopover'
import { Popover } from '@/components/common/Popover'
import { DEFAULT_AI_COMMIT_OPTIONS, splitCommitMessage, useAiStatus } from '@/lib/ai'
import { Icon } from '@/lib/icons'
import { usePersistentState } from '@/lib/persist'
import type { CommitMode } from './CommitComposer'

const LENGTHS: Array<{ id: AiCommitOptions['length']; label: string }> = [
  { id: 'short', label: 'Short' },
  { id: 'medium', label: 'Medium' },
  { id: 'long', label: 'Long' }
]

const TONES: Array<{ id: AiCommitOptions['tone']; label: string }> = [
  { id: 'technical', label: 'Technical' },
  { id: 'formal', label: 'Formal' },
  { id: 'informal', label: 'Informal' },
  { id: 'friendly', label: 'Friendly' }
]

interface Props {
  repoPath: string
  mode: CommitMode
  /** Blocks generating (not the teaser): busy, committing, empty selection. */
  disabledReason: string | null
  /** Snapshot of the checkbox selection, taken when generating starts. */
  buildSelection: () => { files: ChangedFile[]; patches: string[] }
  /** Receives the (streaming) generated message, already split for the fields. */
  onMessage: (summary: string, description: string) => void
  /** Open Settings → AI (the teaser's one button). */
  onSetupAi: () => void
  onError: (e: unknown) => void
}

export function AiComposerControls({
  repoPath,
  mode,
  disabledReason,
  buildSelection,
  onMessage,
  onSetupAi,
  onError
}: Props) {
  const status = useAiStatus()
  const [options, setOptions] = usePersistentState<AiCommitOptions>(
    'gg.aiCommitOptions',
    DEFAULT_AI_COMMIT_OPTIONS
  )
  const [teaserOpen, setTeaserOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const clusterRef = useRef<HTMLDivElement>(null)

  // The running generation: its id (chunk filter + cancellation) and the text
  // accumulated so far. Refs, not state — chunks arrive faster than React
  // needs to re-render this component (the fields update via onMessage).
  const requestIdRef = useRef<string | null>(null)
  const accumulatedRef = useRef('')

  useEffect(() => {
    return window.gitgrove.onAiChunk((chunk) => {
      if (chunk.requestId !== requestIdRef.current) return
      accumulatedRef.current += chunk.text
      const { summary, description } = splitCommitMessage(accumulatedRef.current)
      onMessage(summary, description)
    })
  }, [onMessage])

  // Repo switches invalidate a stream mid-flight — stop listening to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoPath is the intentional reset trigger
  useEffect(() => {
    const requestId = requestIdRef.current
    requestIdRef.current = null
    if (requestId) window.gitgrove.aiCancel(requestId).catch(() => {})
    setGenerating(false)
  }, [repoPath])

  const generate = async (opts: AiCommitOptions) => {
    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    accumulatedRef.current = ''
    setGenerating(true)
    try {
      const { files, patches } = buildSelection()
      const message = await window.gitgrove.aiCommitMessage(repoPath, {
        requestId,
        files,
        patches,
        mode,
        options: opts
      })
      // Superseded by a newer run or a repo switch — its text is not ours.
      if (requestIdRef.current !== requestId) return
      const { summary, description } = splitCommitMessage(message)
      onMessage(summary, description)
    } catch (e) {
      if (requestIdRef.current === requestId) onError(e)
    } finally {
      if (requestIdRef.current === requestId) {
        requestIdRef.current = null
        setGenerating(false)
      }
    }
  }

  const stop = () => {
    const requestId = requestIdRef.current
    if (requestId) window.gitgrove.aiCancel(requestId).catch(() => {})
  }

  const onSparkle = () => {
    if (!status) {
      setOptionsOpen(false)
      setTeaserOpen(true)
      return
    }
    if (generating) stop()
    else if (!disabledReason) generate(options)
  }

  const verb = mode === 'stash' ? 'Name this stash' : 'Write this message'
  const tip = generating
    ? 'Stop generating'
    : status
      ? (disabledReason ?? `${verb} with AI`)
      : `${verb} with AI — click to set up`

  return (
    <div className="composer__ai" ref={clusterRef}>
      <button
        type="button"
        className={`ai-btn${generating ? ' is-generating' : ''}`}
        aria-disabled={!!status && !generating && !!disabledReason}
        aria-label={tip}
        data-tip={tip}
        onClick={onSparkle}
      >
        {generating ? <span className="ai-btn__spinner" aria-hidden /> : <Icon.Sparkle size={14} />}
      </button>
      <button
        type="button"
        className="ai-btn ai-btn--caret"
        aria-haspopup="menu"
        aria-label="Message style"
        data-tip="Message style"
        onClick={() => {
          if (!status) setTeaserOpen(true)
          else setOptionsOpen(true)
        }}
      >
        <Icon.Chevron size={10} />
      </button>

      <AiTeaserPopover
        anchor={clusterRef.current}
        open={teaserOpen}
        onClose={() => setTeaserOpen(false)}
        title={`${verb} with AI`}
        body="GitGrove writes the message from exactly the changes you selected."
        onSetup={onSetupAi}
      />

      <Popover
        anchor={clusterRef.current}
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        align="right"
        width={252}
      >
        <div className="ai-options">
          <div className="ai-options__head">
            <span>Message style</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Regenerate with this style"
              data-tip={disabledReason ?? 'Regenerate with this style'}
              aria-disabled={!!disabledReason || generating}
              onClick={() => {
                if (disabledReason || generating) return
                setOptionsOpen(false)
                generate(options)
              }}
            >
              <Icon.Refresh size={13} />
            </button>
          </div>
          <div className="ai-options__row">
            <span className="ai-options__label">Length</span>
            <div className="segmented ai-options__segmented" role="radiogroup" aria-label="Length">
              {LENGTHS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={options.length === l.id}
                  className={options.length === l.id ? 'is-active' : ''}
                  onClick={() => setOptions({ ...options, length: l.id })}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div className="ai-options__row">
            <span className="ai-options__label">Tone</span>
            <select
              className="ai-select"
              value={options.tone}
              aria-label="Tone"
              onChange={(e) =>
                setOptions({ ...options, tone: e.target.value as AiCommitOptions['tone'] })
              }
            >
              {TONES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ai-options__row">
            <span className="ai-options__label">Use emojis</span>
            <button
              type="button"
              role="switch"
              aria-checked={options.emojis}
              aria-label="Use emojis"
              className={`ai-switch${options.emojis ? ' is-on' : ''}`}
              onClick={() => setOptions({ ...options, emojis: !options.emojis })}
            >
              <span className="ai-switch__thumb" />
            </button>
          </div>
        </div>
      </Popover>
    </div>
  )
}
