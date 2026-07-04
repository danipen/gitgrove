import { describe, expect, test } from 'bun:test'
import {
  type AiEndpoint,
  buildChatRequest,
  buildModelsRequest,
  extractStreamText,
  parseModelList,
  pickDefaultModel,
  resolveBaseUrl
} from './providers'

const endpoint = (over: Partial<AiEndpoint> = {}): AiEndpoint => ({
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-test',
  apiKey: 'sk-secret',
  ...over
})

const messages = [
  { role: 'system' as const, content: 'You write commit messages.' },
  { role: 'user' as const, content: 'Diff here.' }
]

describe('resolveBaseUrl', () => {
  test('defaults from the provider when the input is empty', () => {
    expect(resolveBaseUrl('openai')).toBe('https://api.openai.com/v1')
    expect(resolveBaseUrl('ollama', '')).toBe('http://localhost:11434/v1')
  })

  test('normalizes user input (trim + trailing slashes)', () => {
    expect(resolveBaseUrl('litellm', ' https://llm.corp/v1// ')).toBe('https://llm.corp/v1')
  })

  test('null when a required URL is missing', () => {
    expect(resolveBaseUrl('litellm')).toBeNull()
    expect(resolveBaseUrl('custom', '  ')).toBeNull()
  })
})

describe('buildChatRequest', () => {
  test('openai-compatible: bearer auth, system message in-band, streaming on', () => {
    const req = buildChatRequest(endpoint(), messages)
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(req.headers.Authorization).toBe('Bearer sk-secret')
    const body = JSON.parse(req.body ?? '')
    expect(body.model).toBe('gpt-test')
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual(messages)
  })

  test('keyless endpoints send no auth header at all', () => {
    const req = buildChatRequest(endpoint({ provider: 'ollama', apiKey: null }), messages)
    expect(req.headers.Authorization).toBeUndefined()
  })

  test('anthropic: x-api-key + version headers, system extracted', () => {
    const req = buildChatRequest(
      endpoint({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }),
      messages
    )
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers['x-api-key']).toBe('sk-secret')
    expect(req.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(req.body ?? '')
    expect(body.system).toBe('You write commit messages.')
    expect(body.messages).toEqual([{ role: 'user', content: 'Diff here.' }])
    expect(body.stream).toBe(true)
  })

  test('gemini: model in the URL, SSE alt, systemInstruction part', () => {
    const req = buildChatRequest(
      endpoint({
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-2.5-flash'
      }),
      messages
    )
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
    )
    expect(req.headers['x-goog-api-key']).toBe('sk-secret')
    const body = JSON.parse(req.body ?? '')
    expect(body.systemInstruction.parts[0].text).toBe('You write commit messages.')
    expect(body.contents[0].parts[0].text).toBe('Diff here.')
  })
})

describe('buildModelsRequest', () => {
  test('openai-compatible and anthropic hit /models', () => {
    expect(buildModelsRequest(endpoint()).url).toBe('https://api.openai.com/v1/models')
  })

  test('gemini pages wide so small models are not cut off', () => {
    const req = buildModelsRequest(
      endpoint({ provider: 'gemini', baseUrl: 'https://g/v1beta' })
    )
    expect(req.url).toBe('https://g/v1beta/models?pageSize=200')
  })
})

describe('parseModelList', () => {
  test('openai/anthropic: data[].id', () => {
    const payload = { data: [{ id: 'gpt-a' }, { id: 'gpt-b' }, { broken: true }] }
    expect(parseModelList('openai', payload)).toEqual(['gpt-a', 'gpt-b'])
    expect(parseModelList('anthropic', payload)).toEqual(['gpt-a', 'gpt-b'])
  })

  test('gemini: models[].name stripped of the models/ prefix, chat-capable only', () => {
    const payload = {
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-x' }
      ]
    }
    expect(parseModelList('gemini', payload)).toEqual(['gemini-2.5-flash', 'gemini-x'])
  })

  test('garbage payloads yield an empty list, never a throw', () => {
    expect(parseModelList('openai', null)).toEqual([])
    expect(parseModelList('gemini', 'nope')).toEqual([])
    expect(parseModelList('openai', { data: 'nope' })).toEqual([])
  })
})

describe('pickDefaultModel', () => {
  test('prefers the provider’s fast models, exact or dated variant', () => {
    expect(pickDefaultModel('openai', ['gpt-4.1', 'gpt-4o-mini', 'o9'])).toBe('gpt-4o-mini')
    expect(pickDefaultModel('anthropic', ['claude-opus-4-8', 'claude-haiku-4-5-20251001'])).toBe(
      'claude-haiku-4-5-20251001'
    )
  })

  test('falls back to the first served model', () => {
    expect(pickDefaultModel('litellm', ['corp-model', 'other'])).toBe('corp-model')
    expect(pickDefaultModel('openai', [])).toBe('')
  })
})

describe('extractStreamText', () => {
  test('openai-compatible deltas', () => {
    expect(
      extractStreamText('openai', { choices: [{ delta: { content: 'Fix ' } }] })
    ).toBe('Fix ')
    expect(extractStreamText('openai', { choices: [{ delta: { role: 'assistant' } }] })).toBe('')
  })

  test('anthropic content_block_delta only', () => {
    expect(
      extractStreamText('anthropic', { type: 'content_block_delta', delta: { text: 'Fix ' } })
    ).toBe('Fix ')
    expect(extractStreamText('anthropic', { type: 'message_start' })).toBe('')
  })

  test('gemini candidate parts, concatenated', () => {
    const event = { candidates: [{ content: { parts: [{ text: 'Fix ' }, { text: 'bug' }] } }] }
    expect(extractStreamText('gemini', event)).toBe('Fix bug')
  })

  test('malformed events contribute nothing, never a throw', () => {
    expect(extractStreamText('openai', null)).toBe('')
    expect(extractStreamText('anthropic', { type: 'content_block_delta' })).toBe('')
    expect(extractStreamText('gemini', { candidates: [{}] })).toBe('')
  })
})
