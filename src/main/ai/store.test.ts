import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountCipher } from '../accounts/store'
import { type AiConfig, AiStore } from './store'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitgrove-ai-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Reversible fake so tests can assert what hit the disk without an OS vault. */
const fakeCipher = (available = true): AccountCipher => ({
  available: () => available,
  encrypt: (text) => `enc:${Buffer.from(text).toString('base64')}`,
  decrypt: (payload) =>
    payload.startsWith('enc:') ? Buffer.from(payload.slice(4), 'base64').toString() : null
})

const config = (over: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  defaultBaseUrl: true,
  model: 'claude-haiku-4-5',
  models: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
  ...over
})

let seq = 0
const newStore = (cipher = fakeCipher()) => {
  const file = join(dir, `ai-${++seq}.json`)
  return { store: new AiStore(file, cipher), file }
}

describe('AiStore', () => {
  test('starts unconfigured', () => {
    const { store } = newStore()
    expect(store.status()).toBeNull()
    expect(store.endpoint()).toBeNull()
  })

  test('save → status hides the default base URL and never the key', () => {
    const { store, file } = newStore()
    const status = store.save(config(), 'sk-secret')
    expect(status.provider).toBe('anthropic')
    expect(status.model).toBe('claude-haiku-4-5')
    expect(status.baseUrl).toBeNull()
    expect(status.persisted).toBe(true)
    // The key reaches disk only as ciphertext.
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('sk-secret')
    expect(raw).toContain('enc:')
  })

  test('a custom base URL surfaces in the status', () => {
    const { store } = newStore()
    const status = store.save(
      config({ provider: 'litellm', baseUrl: 'https://llm.corp/v1', defaultBaseUrl: false }),
      null
    )
    expect(status.baseUrl).toBe('https://llm.corp/v1')
  })

  test('endpoint decrypts the key for generations', () => {
    const { store } = newStore()
    store.save(config(), 'sk-secret')
    expect(store.endpoint()).toEqual({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-secret'
    })
  })

  test('keyless endpoints persist with a null key', () => {
    const { store } = newStore()
    const status = store.save(
      config({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' }),
      null
    )
    expect(status.persisted).toBe(true)
    expect(store.endpoint()?.apiKey).toBeNull()
  })

  test('without a usable cipher the key stays session-only', () => {
    const { store, file } = newStore(fakeCipher(false))
    const status = store.save(config(), 'sk-secret')
    expect(status.persisted).toBe(false)
    expect(store.endpoint()?.apiKey).toBe('sk-secret')
    // Nothing configured hit the disk — a restart forgets the backend.
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  test('setModel switches the generation model in place', () => {
    const { store } = newStore()
    store.save(config(), 'sk-secret')
    store.setModel('claude-sonnet-4-5')
    expect(store.status()?.model).toBe('claude-sonnet-4-5')
    expect(store.endpoint()?.model).toBe('claude-sonnet-4-5')
    expect(store.endpoint()?.apiKey).toBe('sk-secret')
  })

  test('clear forgets everything', () => {
    const { store } = newStore()
    store.save(config(), 'sk-secret')
    store.clear()
    expect(store.status()).toBeNull()
    expect(store.endpoint()).toBeNull()
  })

  test('a malformed file reads as unconfigured, never as a broken endpoint', () => {
    const { store, file } = newStore()
    writeFileSync(file, '{"provider":"anthropic","model":""}', 'utf8')
    expect(store.status()).toBeNull()
    writeFileSync(file, 'not json', 'utf8')
    expect(store.status()).toBeNull()
  })

  test('an undecryptable stored key yields a null-key endpoint (reconnect path)', () => {
    const { store, file } = newStore()
    store.save(config(), 'sk-secret')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.keyCipher = 'garbage-from-another-machine'
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    expect(store.status()).not.toBeNull()
    expect(store.endpoint()?.apiKey).toBeNull()
  })
})
