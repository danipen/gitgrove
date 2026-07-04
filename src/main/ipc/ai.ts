// AI assist: connect/verify the bring-your-own backend, and run generations.
// Generations stream their tokens back to the window that asked (never
// broadcast — another window's composer must not receive this one's text)
// and are cancellable by requestId. The API key never crosses to a renderer:
// it arrives once in aiConnect and lives encrypted in the AI store.

import { IPC } from '@shared/ipc'
import type { AiChunk, AiCommitRequest, AiConnectInput, AiConnectResult } from '@shared/types'
import { ipcMain } from 'electron'
import { aiStore } from '../ai/cipher'
import { AiRequestError, streamChat, verifyEndpoint } from '../ai/client'
import { gatherCommitContext } from '../ai/commit-context'
import { buildCommitPrompt } from '../ai/commit-prompt'
import { resolveBaseUrl } from '../ai/providers'
import type { HandlerDeps } from './context'

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
  // generations (composer now, branch names later) without cross-talk.
  const inFlight = new Map<string, AbortController>()

  ipcMain.handle(
    IPC.aiCommitMessage,
    async (e, repoPath: string, request: AiCommitRequest): Promise<string> => {
      const endpoint = aiStore().endpoint()
      // The renderer gates the button on aiStatus, so this only races a
      // just-disconnected backend — answer like any other failed generation.
      if (!endpoint) throw new Error('No AI backend is connected — set one up in Settings.')
      const controller = new AbortController()
      inFlight.set(request.requestId, controller)
      try {
        const context = await gatherCommitContext(repoPath, request)
        return await streamChat(endpoint, buildCommitPrompt(context), {
          signal: controller.signal,
          onText: (text) => {
            if (e.sender.isDestroyed()) return
            const chunk: AiChunk = { requestId: request.requestId, text }
            e.sender.send(IPC.aiChunk, chunk)
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
        inFlight.delete(request.requestId)
      }
    }
  )

  ipcMain.handle(IPC.aiCancel, (_e, requestId: string) => {
    inFlight.get(requestId)?.abort()
  })
}
