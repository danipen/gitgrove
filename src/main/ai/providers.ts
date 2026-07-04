// The AI provider registry and its wire formats — all pure functions, so the
// exact requests GitGrove sends (URLs, headers, bodies) and how it reads the
// responses are unit-testable without a network. The impure half (fetch +
// SSE reading) lives in client.ts; this module never touches I/O.
//
// Three dialects cover every supported backend: the OpenAI-compatible chat
// API (openai, litellm, ollama, custom — the de-facto standard every proxy
// speaks), Anthropic's Messages API, and Google's Gemini API.

import type { AiProvider } from '@shared/types'

/** Static per-provider knowledge, driving both main and the settings UI copy. */
export interface AiProviderMeta {
  label: string
  /** Default endpoint; null when the user must supply one (litellm/custom). */
  defaultBaseUrl: string | null
  /** Whether the endpoint expects an API key. Ollama runs keyless locally. */
  needsKey: 'required' | 'optional' | 'none'
  /** Where to create a key, opened prefilled from the settings pane. */
  keyUrl: string | null
  /**
   * Models to prefer when picking a default from the endpoint's list, best
   * first — small, fast models: commit messages are short and latency is UX.
   */
  preferredModels: string[]
}

export const AI_PROVIDERS: Record<AiProvider, AiProviderMeta> = {
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsKey: 'required',
    keyUrl: 'https://platform.openai.com/api-keys',
    preferredModels: ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini']
  },
  anthropic: {
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    needsKey: 'required',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    preferredModels: ['claude-haiku-4-5', 'claude-3-5-haiku-latest']
  },
  gemini: {
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    needsKey: 'required',
    keyUrl: 'https://aistudio.google.com/apikey',
    preferredModels: ['gemini-2.5-flash', 'gemini-2.0-flash']
  },
  litellm: {
    label: 'LiteLLM',
    defaultBaseUrl: null,
    needsKey: 'optional',
    keyUrl: null,
    preferredModels: []
  },
  ollama: {
    label: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    needsKey: 'none',
    keyUrl: null,
    preferredModels: ['qwen3', 'llama3.2', 'mistral']
  },
  custom: {
    label: 'Custom endpoint',
    defaultBaseUrl: null,
    needsKey: 'optional',
    keyUrl: null,
    preferredModels: []
  }
}

/** Everything a request needs, resolved (base URL defaulted, key decrypted). */
export interface AiEndpoint {
  provider: AiProvider
  /** Base URL without a trailing slash. */
  baseUrl: string
  model: string
  apiKey: string | null
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** A ready-to-send HTTP request, as data (client.ts does the fetch). */
export interface WireRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

/**
 * The user's base URL input, normalized: trimmed, trailing slashes dropped,
 * and defaulted from the provider when empty. Null when the provider has no
 * default and the user gave nothing — the settings pane blocks that before
 * ever calling main.
 */
export function resolveBaseUrl(provider: AiProvider, input?: string): string | null {
  const trimmed = (input ?? '').trim().replace(/\/+$/, '')
  return trimmed || AI_PROVIDERS[provider].defaultBaseUrl
}

/** Auth headers per dialect; empty when the endpoint runs keyless. */
function authHeaders(endpoint: Pick<AiEndpoint, 'provider' | 'apiKey'>): Record<string, string> {
  if (!endpoint.apiKey) return {}
  switch (endpoint.provider) {
    case 'anthropic':
      return { 'x-api-key': endpoint.apiKey, 'anthropic-version': '2023-06-01' }
    case 'gemini':
      return { 'x-goog-api-key': endpoint.apiKey }
    default:
      return { Authorization: `Bearer ${endpoint.apiKey}` }
  }
}

/** The streaming chat-completion request for one prompt. */
export function buildChatRequest(endpoint: AiEndpoint, messages: ChatMessage[]): WireRequest {
  const headers = { 'content-type': 'application/json', ...authHeaders(endpoint) }
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const user = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n')

  switch (endpoint.provider) {
    case 'anthropic':
      return {
        url: `${endpoint.baseUrl}/messages`,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: endpoint.model,
          // Generous ceiling — Anthropic requires one; prompts ask for brevity.
          max_tokens: 1024,
          stream: true,
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: user }]
        })
      }
    case 'gemini':
      return {
        // `alt=sse` turns the chunked JSON stream into standard SSE events.
        url: `${endpoint.baseUrl}/models/${endpoint.model}:streamGenerateContent?alt=sse`,
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: user }] }]
        })
      }
    default:
      // OpenAI-compatible. No token cap on purpose: newer OpenAI models and
      // older proxies disagree on the cap's field name, and the prompt already
      // constrains the length.
      return {
        url: `${endpoint.baseUrl}/chat/completions`,
        method: 'POST',
        headers,
        body: JSON.stringify({ model: endpoint.model, stream: true, messages })
      }
  }
}

/** The "list models" request used to verify an endpoint at connect time. */
export function buildModelsRequest(endpoint: Omit<AiEndpoint, 'model'>): WireRequest {
  const headers = authHeaders(endpoint)
  const url =
    endpoint.provider === 'gemini'
      ? `${endpoint.baseUrl}/models?pageSize=200`
      : `${endpoint.baseUrl}/models`
  return { url, method: 'GET', headers }
}

/** Model ids out of a models-list response, newest-ish first as served. */
export function parseModelList(provider: AiProvider, payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  if (provider === 'gemini') {
    const models = Array.isArray(obj.models) ? obj.models : []
    return models
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .filter((m) => {
        const methods = m.supportedGenerationMethods
        return !Array.isArray(methods) || methods.includes('generateContent')
      })
      .map((m) => String(m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
  }
  // OpenAI-compatible and Anthropic both answer `{ data: [{ id }] }`.
  const data = Array.isArray(obj.data) ? obj.data : []
  return data
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => String(m.id ?? ''))
    .filter(Boolean)
}

/**
 * The model a fresh connection starts on: the first preferred model the
 * endpoint actually serves (exact id or a dated/versioned variant of it),
 * else the endpoint's first model. Never empty when `models` isn't.
 */
export function pickDefaultModel(provider: AiProvider, models: string[]): string {
  for (const preferred of AI_PROVIDERS[provider].preferredModels) {
    const hit = models.find((m) => m === preferred || m.startsWith(`${preferred}-`))
    if (hit) return hit
  }
  return models[0] ?? ''
}

/**
 * The text a single SSE event contributes to the generation, or '' for
 * bookkeeping events (role deltas, stop reasons, pings). `data` is the parsed
 * JSON of one `data:` line.
 */
export function extractStreamText(provider: AiProvider, data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const obj = data as Record<string, unknown>
  if (provider === 'anthropic') {
    if (obj.type !== 'content_block_delta') return ''
    const delta = obj.delta as Record<string, unknown> | undefined
    return typeof delta?.text === 'string' ? delta.text : ''
  }
  if (provider === 'gemini') {
    const candidates = obj.candidates
    if (!Array.isArray(candidates) || !candidates[0]) return ''
    const content = (candidates[0] as Record<string, unknown>).content as
      | Record<string, unknown>
      | undefined
    const parts = content?.parts
    if (!Array.isArray(parts)) return ''
    return parts
      .map((p) => {
        const part = p as Record<string, unknown> | null
        return typeof part?.text === 'string' ? part.text : ''
      })
      .join('')
  }
  // OpenAI-compatible: choices[0].delta.content.
  const choices = obj.choices
  if (!Array.isArray(choices) || !choices[0]) return ''
  const delta = (choices[0] as Record<string, unknown>).delta as
    | Record<string, unknown>
    | undefined
  return typeof delta?.content === 'string' ? delta.content : ''
}
