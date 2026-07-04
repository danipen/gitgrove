// The "how do I enable this?" popover every unconfigured AI ✨ opens — one
// pitch, one button, gone on outside click. Shared by every AI surface
// (composer, branch dialog, explanations) so the setup story reads identically
// wherever the user first meets it. styles: features/ai.css (.ai-teaser)

import { Icon } from '@/lib/icons'
import { Popover } from './Popover'

interface Props {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  /** What this surface does, e.g. "Name this branch with AI". */
  title: string
  /** One pitch sentence specific to this surface. */
  body: string
  /** Open Settings → AI (the teaser's one button). */
  onSetup: () => void
}

export function AiTeaserPopover({ anchor, open, onClose, title, body, onSetup }: Props) {
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="right" width={280}>
      <div className="ai-teaser">
        <div className="ai-teaser__title">
          <Icon.Sparkle size={15} /> {title}
        </div>
        <p className="ai-teaser__body">
          {body} Connect OpenAI, Anthropic, Gemini, a local Ollama or any compatible endpoint — your
          key, sent only to your provider.
        </p>
        <button
          type="button"
          className="btn-primary btn-primary--sm ai-teaser__cta"
          onClick={() => {
            onClose()
            onSetup()
          }}
        >
          Set up AI…
        </button>
      </div>
    </Popover>
  )
}
