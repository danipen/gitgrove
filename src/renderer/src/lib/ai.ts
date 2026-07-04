// Shared AI-assist logic for every AI surface (the composer's ✨ today,
// branch names and conflict help tomorrow): the provider metadata the
// onboarding shows, the status hook the buttons key off, and the pure
// message-shaping helpers. Talking to the backend happens in main — the
// renderer only ever sees text.

import type { AiCommitOptions, AiErrorCode, AiProvider, AiStatus } from '@shared/types'
import { useEffect, useState } from 'react'

/** One provider card in the settings onboarding, in display order. */
export interface AiProviderChoice {
  id: AiProvider
  label: string
  sub: string
  /** Where to create a key ("Create key…" button); null when keyless/self-hosted. */
  keyUrl: string | null
  /** Whether the pane asks for an endpoint URL, and what it hints. */
  needsBaseUrl: boolean
  baseUrlPlaceholder?: string
  /** Whether the pane asks for a key, and whether it may be left empty. */
  needsKey: boolean
  keyOptional: boolean
}

export const AI_PROVIDER_CHOICES: AiProviderChoice[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    sub: 'GPT models — platform.openai.com key',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsBaseUrl: false,
    needsKey: true,
    keyOptional: false
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    sub: 'Claude models — console.anthropic.com key',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsBaseUrl: false,
    needsKey: true,
    keyOptional: false
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    sub: 'Gemini models — aistudio.google.com key',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsBaseUrl: false,
    needsKey: true,
    keyOptional: false
  },
  {
    id: 'ollama',
    label: 'Ollama',
    sub: 'Local models on this machine — no key needed',
    keyUrl: null,
    needsBaseUrl: true,
    baseUrlPlaceholder: 'http://localhost:11434/v1',
    needsKey: false,
    keyOptional: true
  },
  {
    id: 'litellm',
    label: 'LiteLLM / custom endpoint',
    sub: 'Any OpenAI-compatible server or proxy',
    keyUrl: null,
    needsBaseUrl: true,
    baseUrlPlaceholder: 'https://llm.example.com/v1',
    needsKey: true,
    keyOptional: true
  }
]

/** Display label for a connected provider (settings summary card). */
export function aiProviderLabel(provider: AiProvider): string {
  return AI_PROVIDER_CHOICES.find((c) => c.id === provider)?.label ?? 'Custom endpoint'
}

/** Human copy for the stable failure codes a connect can come back with. */
export function aiErrorCopy(code: AiErrorCode, detail?: string): string {
  switch (code) {
    case 'unauthorized':
      return 'The endpoint did not accept that key.'
    case 'network':
      return 'Could not reach the endpoint — check the address and your connection.'
    case 'bad-endpoint':
      return detail ?? 'No compatible API answered at that address.'
    case 'provider-error':
      return detail ?? 'The endpoint answered with an error.'
    case 'cancelled':
      return ''
  }
}

/**
 * The connected AI backend, kept fresh across every window: undefined while
 * loading, null when none is connected. Every AI surface keys its button off
 * this — visible either way, but unconfigured clicks open the setup teaser.
 */
export function useAiStatus(): AiStatus | null | undefined {
  const [status, setStatus] = useState<AiStatus | null | undefined>(undefined)
  useEffect(() => {
    let stale = false
    const load = () =>
      window.gitgrove
        .aiStatus()
        .then((s) => {
          if (!stale) setStatus(s)
        })
        .catch(() => {})
    load()
    const unsubscribe = window.gitgrove.onAiChanged(load)
    return () => {
      stale = true
      unsubscribe()
    }
  }, [])
  return status
}

export const DEFAULT_AI_COMMIT_OPTIONS: AiCommitOptions = {
  length: 'medium',
  tone: 'technical',
  emojis: false
}

/**
 * Split a (possibly still-streaming) generated message into the composer's
 * summary + description fields, defensively stripping the wrappers models
 * sometimes add despite instructions (code fences, surrounding quotes).
 */
export function splitCommitMessage(text: string): { summary: string; description: string } {
  let cleaned = text.replace(/^\s*```[a-z]*\n?/, '').replace(/\n?```\s*$/, '')
  cleaned = cleaned.trim()
  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length > 1) {
    cleaned = cleaned.slice(1, -1)
  }
  const newline = cleaned.indexOf('\n')
  if (newline < 0) return { summary: cleaned, description: '' }
  return {
    summary: cleaned.slice(0, newline).trim(),
    description: cleaned
      .slice(newline + 1)
      .replace(/^\n+/, '')
      .trimEnd()
  }
}
