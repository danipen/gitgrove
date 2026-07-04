// The one place AI bytes cross the network: a fetch of a WireRequest plus an
// SSE reader. Everything about *what* is sent and *how* responses are read is
// pure and lives in providers.ts; this module only does I/O. Keys never leave
// the main process and are never logged.

import type { AiErrorCode } from '@shared/types'
import {
  type AiEndpoint,
  buildChatRequest,
  buildModelsRequest,
  type ChatMessage,
  extractStreamText,
  parseModelList,
  pickDefaultModel,
  type WireRequest
} from './providers'

/** A failure with a stable code the renderer maps to calm copy. */
export class AiRequestError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** How long a connect-time verification may take before failing as network. */
const VERIFY_TIMEOUT_MS = 15_000
/** Ceiling on one generation — a stuck stream must not spin forever. */
const GENERATION_TIMEOUT_MS = 90_000

function classifyHttp(status: number): AiRequestError {
  if (status === 401 || status === 403)
    return new AiRequestError('unauthorized', 'The endpoint rejected the API key.')
  if (status === 404)
    return new AiRequestError('bad-endpoint', 'No compatible API at that address.')
  return new AiRequestError('provider-error', `The endpoint answered with HTTP ${status}.`)
}

async function send(request: WireRequest, signal: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal
    })
  } catch (e) {
    if (signal.aborted) throw new AiRequestError('cancelled', 'Cancelled.')
    throw new AiRequestError(
      'network',
      `Could not reach the endpoint${e instanceof Error && e.message ? ` (${e.message})` : ''}.`
    )
  }
  if (!response.ok) throw classifyHttp(response.status)
  return response
}

/**
 * Verify an endpoint live and list its models — the connect-time handshake.
 * Succeeding here is what "connected" means; nothing is saved before it.
 */
export async function verifyEndpoint(
  endpoint: Omit<AiEndpoint, 'model'>
): Promise<{ models: string[]; defaultModel: string }> {
  const response = await send(buildModelsRequest(endpoint), AbortSignal.timeout(VERIFY_TIMEOUT_MS))
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new AiRequestError('bad-endpoint', 'That address did not answer with a model list.')
  }
  const models = parseModelList(endpoint.provider, payload)
  if (models.length === 0)
    throw new AiRequestError('bad-endpoint', 'The endpoint lists no usable models.')
  return { models, defaultModel: pickDefaultModel(endpoint.provider, models) }
}

/**
 * Run one streaming chat completion. `onText` fires per streamed piece;
 * resolves with the full text. Cancellation (the caller's signal) resolves
 * with what was generated so far — a half-written suggestion is still a
 * suggestion, and the composer keeps it editable.
 */
export async function streamChat(
  endpoint: AiEndpoint,
  messages: ChatMessage[],
  opts: { signal: AbortSignal; onText: (text: string) => void }
): Promise<string> {
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)])
  const response = await send(buildChatRequest(endpoint, messages), signal)
  if (!response.body) throw new AiRequestError('provider-error', 'The endpoint sent no stream.')

  // SSE: decode chunks, split into lines, read `data:` payloads. A JSON line
  // that doesn't parse is skipped — proxies occasionally interleave comments.
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  const takeLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const text = extractStreamText(endpoint.provider, JSON.parse(data))
      if (text) {
        full += text
        opts.onText(text)
      }
    } catch {
      // Not JSON — an SSE comment or keep-alive; skip.
    }
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        takeLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    takeLine(buffer)
  } catch (e) {
    // A user cancel mid-stream keeps the partial text (see the contract above);
    // the timeout or a dropped connection is a real failure.
    if (opts.signal.aborted) return full.trim()
    if (e instanceof AiRequestError) throw e
    throw new AiRequestError('network', 'The stream ended unexpectedly.')
  }
  return full.trim()
}
