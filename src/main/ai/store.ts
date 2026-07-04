// AI backend persistence. Non-secret config (provider, base URL, model, the
// model list) lives in a JSON file in userData; the API key is encrypted by
// the injected cipher (OS vault via Electron safeStorage in production) and
// only its ciphertext touches disk. When no real encryption is available
// (Linux without a keyring), the key is kept in memory for the session
// instead of being written ~plaintext — same contract as the accounts store.
//
// Deliberately Electron-free so the store is unit-testable with a temp file
// and a fake cipher (see cipher.ts for the production wiring).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AiProvider, AiStatus } from '@shared/types'
import type { AccountCipher } from '../accounts/store'
import type { AiEndpoint } from './providers'

/** What a verified connect hands the store (the key passed separately). */
export interface AiConfig {
  provider: AiProvider
  /** Resolved base URL (never null once connected). */
  baseUrl: string
  /** True when the URL is just the provider's default — hidden in the UI. */
  defaultBaseUrl: boolean
  model: string
  models: string[]
}

interface StoreFile extends AiConfig {
  /** Ciphertext of the API key; null for keyless endpoints. */
  keyCipher: string | null
}

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'gemini', 'litellm', 'ollama', 'custom']

/**
 * Defensive shape check for the file read back from disk — a hand-edit or
 * partial write must yield "not configured", never a malformed endpoint.
 */
function isStoreFile(value: unknown): value is StoreFile {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    PROVIDERS.includes(c.provider as AiProvider) &&
    typeof c.baseUrl === 'string' &&
    typeof c.defaultBaseUrl === 'boolean' &&
    typeof c.model === 'string' &&
    c.model.length > 0 &&
    Array.isArray(c.models) &&
    (c.keyCipher === null || typeof c.keyCipher === 'string')
  )
}

export class AiStore {
  /** Session-only fallbacks when the cipher can't protect the key at rest. */
  private sessionKey: string | null = null
  private sessionConfig: AiConfig | null = null

  constructor(
    private readonly file: string,
    private readonly cipher: AccountCipher
  ) {}

  /** The renderer-visible summary, or null when nothing is connected. */
  status(): AiStatus | null {
    if (this.sessionConfig) return this.toStatus(this.sessionConfig, false)
    const stored = this.read()
    return stored ? this.toStatus(stored, true) : null
  }

  /** The resolved endpoint for a generation, or null (not configured / key lost). */
  endpoint(): AiEndpoint | null {
    if (this.sessionConfig) {
      return {
        provider: this.sessionConfig.provider,
        baseUrl: this.sessionConfig.baseUrl,
        model: this.sessionConfig.model,
        apiKey: this.sessionKey
      }
    }
    const stored = this.read()
    if (!stored) return null
    // A keyless endpoint decrypts to null harmlessly; an undecryptable stored
    // key (OS reinstall) also yields null — the endpoint then answers 401 and
    // the renderer's error copy points at reconnecting.
    const apiKey = stored.keyCipher === null ? null : this.cipher.decrypt(stored.keyCipher)
    return { provider: stored.provider, baseUrl: stored.baseUrl, model: stored.model, apiKey }
  }

  /** Persist a *verified* backend (connect always verifies first). */
  save(config: AiConfig, apiKey: string | null): AiStatus {
    this.clear()
    if (apiKey !== null && !this.cipher.available()) {
      this.sessionConfig = config
      this.sessionKey = apiKey
      return this.toStatus(config, false)
    }
    const keyCipher = apiKey === null ? null : this.cipher.encrypt(apiKey)
    this.write({ ...config, keyCipher })
    return this.toStatus(config, true)
  }

  /** Switch the generation model, keeping everything else (incl. the key). */
  setModel(model: string): void {
    if (this.sessionConfig) {
      this.sessionConfig = { ...this.sessionConfig, model }
      return
    }
    const stored = this.read()
    if (stored) this.write({ ...stored, model })
  }

  /** Forget the backend and its key. */
  clear(): void {
    this.sessionConfig = null
    this.sessionKey = null
    try {
      if (existsSync(this.file)) writeFileSync(this.file, JSON.stringify({}), 'utf8')
    } catch {
      // Non-fatal: with the session state dropped the backend reads as gone.
    }
  }

  private toStatus(config: AiConfig, persisted: boolean): AiStatus {
    return {
      provider: config.provider,
      model: config.model,
      models: config.models,
      baseUrl: config.defaultBaseUrl ? null : config.baseUrl,
      persisted
    }
  }

  private read(): StoreFile | null {
    try {
      if (!existsSync(this.file)) return null
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return isStoreFile(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private write(data: StoreFile): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8')
    } catch {
      // Non-fatal: the backend still works this session via the session state.
      this.sessionConfig = { ...data }
      this.sessionKey = data.keyCipher === null ? null : this.cipher.decrypt(data.keyCipher)
    }
  }
}
