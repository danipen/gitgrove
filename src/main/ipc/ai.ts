// AI assist: connect/verify the bring-your-own backend, and run generations.
// Generations stream their tokens back to the window that asked (never
// broadcast — another window's composer must not receive this one's text)
// and are cancellable by requestId. The API key never crosses to a renderer:
// it arrives once in aiConnect and lives encrypted in the AI store.
//
// Every feature (commit messages, branch names, explanations) funnels through
// one `generate` runner, so streaming, cancellation and error mapping behave
// identically on every AI surface.

import { IPC } from '@shared/ipc'
import type {
  AiBranchNameRequest,
  AiChunk,
  AiCommitRequest,
  AiConnectInput,
  AiConnectResult,
  AiExplainCommitRequest,
  AiExplainErrorRequest
} from '@shared/types'
import { ipcMain } from 'electron'
import {
  buildBranchNamePrompt,
  gatherBranchNameContext,
  slugFromModelOutput
} from '../ai/branch-name'
import { aiStore } from '../ai/cipher'
import { AiRequestError, streamChat, verifyEndpoint } from '../ai/client'
import { gatherCommitContext } from '../ai/commit-context'
import { buildCommitPrompt } from '../ai/commit-prompt'
import { buildExplainCommitPrompt, gatherExplainCommitContext } from '../ai/explain-commit'
import { buildExplainErrorPrompt } from '../ai/explain-error'
import type { ChatMessage } from '../ai/providers'
import { resolveBaseUrl } from '../ai/providers'
import type { HandlerDeps } from './context'

/**
 * Commits are immutable, so explanations cache forever — keyed by model too,
 * because switching models legitimately changes the answer. Small LRU: a
 * session revisits recent commits, not hundreds.
 */
const EXPLAIN_CACHE_MAX = 80
const explainCache = new Map<string, string>()

function cacheGet(key: string): string | undefined {
  const hit = explainCache.get(key)
  if (hit !== undefined) {
    // Refresh recency (Map iterates in insertion order — delete + set = LRU).
    explainCache.delete(key)
    explainCache.set(key, hit)
  }
  return hit
}

function cachePut(key: string, value: string): void {
  explainCache.set(key, value)
  while (explainCache.size > EXPLAIN_CACHE_MAX) {
    const oldest = explainCache.keys().next().value
    if (oldest === undefined) break
    explainCache.delete(oldest)
  }
}

export function registerAiHandlers(deps: HandlerDeps): void {
  const { broadcast } = deps

  ipcMain.handle(IPC.aiStatus, () => aiStore().status())

  ipcMain.handle(IPC.aiConnect, async (_e, input: AiConnectInput): Promise<AiConnectResult> => {
    const baseUrl = resolveBaseUrl(input.provider, input.baseUrl)
    if (!baseUrl) return { ok: false, code: 'bad-endpoint', detail: 'An endpoint URL is needed.' }
    const apiKey = input.apiKey?.trim() || null
    try {
      // Verify live before saving anything: "connected" must mean "works".
      const { models, defaultModel } = await verifyEndpoint({
        provider: input.provider,
        baseUrl,
        apiKey
      })
      const status = aiStore().save(
        {
          provider: input.provider,
          baseUrl,
          defaultBaseUrl: !input.baseUrl?.trim(),
          model: defaultModel,
          models
        },
        apiKey
      )
      // Every window's ✨ buttons and settings pane flip to "connected".
      broadcast(IPC.aiChanged)
      return { ok: true, status }
    } catch (e) {
      if (e instanceof AiRequestError) return { ok: false, code: e.code, detail: e.message }
      return { ok: false, code: 'network', detail: e instanceof Error ? e.message : undefined }
    }
  })

  ipcMain.handle(IPC.aiSetModel, (_e, model: string) => {
    aiStore().setModel(model)
    broadcast(IPC.aiChanged)
  })

  ipcMain.handle(IPC.aiDisconnect, () => {
    aiStore().clear()
    broadcast(IPC.aiChanged)
  })

  // One AbortController per running generation, keyed by the renderer-chosen
  // requestId — cancel is a plain lookup, and a window can run several
  // generations (composer, branch name, an explanation) without cross-talk.
  const inFlight = new Map<string, AbortController>()

  /**
   * Run one streaming generation: resolve the endpoint, gather + build the
   * prompt (lazily — gathering only starts when a backend exists), stream
   * tokens to the asking window, map stable failure codes to calm copy.
   */
  async function generate(
    sender: Electron.WebContents,
    requestId: string,
    messages: () => Promise<ChatMessage[]>
  ): Promise<string> {
    const endpoint = aiStore().endpoint()
    // The renderer gates its buttons on aiStatus, so this only races a
    // just-disconnected backend — answer like any other failed generation.
    if (!endpoint) throw new Error('No AI backend is connected — set one up in Settings.')
    const controller = new AbortController()
    inFlight.set(requestId, controller)
    try {
      return await streamChat(endpoint, await messages(), {
        signal: controller.signal,
        onText: (text) => {
          if (sender.isDestroyed()) return
          const chunk: AiChunk = { requestId, text }
          sender.send(IPC.aiChunk, chunk)
        }
      })
    } catch (err) {
      // Stable codes become calm copy here, so every AI surface fails the
      // same way and no renderer ever parses provider error strings.
      if (err instanceof AiRequestError) {
        if (err.code === 'unauthorized')
          throw new Error('The AI endpoint rejected the key — reconnect it in Settings.')
        throw new Error(err.message)
      }
      throw err
    } finally {
      inFlight.delete(requestId)
    }
  }

  ipcMain.handle(
    IPC.aiCommitMessage,
    (e, repoPath: string, request: AiCommitRequest): Promise<string> =>
      generate(e.sender, request.requestId, async () =>
        buildCommitPrompt(await gatherCommitContext(repoPath, request))
      )
  )

  ipcMain.handle(
    IPC.aiBranchName,
    async (e, repoPath: string, request: AiBranchNameRequest): Promise<string> => {
      // Gather once, outside the prompt closure — the collision set (existing
      // branch names) is needed again to sanitize the answer.
      const context = await gatherBranchNameContext(repoPath)
      const raw = await generate(e.sender, request.requestId, async () =>
        buildBranchNamePrompt(context.prompt)
      )
      // The stream shows the raw text forming; the resolved value is the
      // cleaned, ref-valid, collision-free slug the dialog can trust blindly.
      return slugFromModelOutput(raw, context.takenNames)
    }
  )

  ipcMain.handle(
    IPC.aiExplainCommit,
    async (e, repoPath: string, request: AiExplainCommitRequest): Promise<string> => {
      const endpoint = aiStore().endpoint()
      const key = endpoint
        ? `${endpoint.provider}\0${endpoint.model}\0${repoPath}\0${request.hash}`
        : null
      const cached = key ? cacheGet(key) : undefined
      // A cache hit answers instantly through the invoke result — no chunks.
      if (cached !== undefined) return cached
      const text = await generate(e.sender, request.requestId, async () =>
        buildExplainCommitPrompt(await gatherExplainCommitContext(repoPath, request.hash))
      )
      if (key && text) cachePut(key, text)
      return text
    }
  )

  ipcMain.handle(
    IPC.aiExplainError,
    (e, _repoPath: string | null, request: AiExplainErrorRequest): Promise<string> =>
      generate(e.sender, request.requestId, async () => buildExplainErrorPrompt(request))
  )

  ipcMain.handle(IPC.aiCancel, (_e, requestId: string) => {
    inFlight.get(requestId)?.abort()
  })
}
