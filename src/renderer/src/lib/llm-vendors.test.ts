import { describe, expect, it } from 'bun:test'

import { LlmVendorDetector, llmVendors } from './llm-vendors'

const detect = (name: string, email: string) => llmVendors.detect(name, email)?.id ?? null

describe('LlmVendorDetector.detect — by email', () => {
  it('recognizes Claude Code attributions', () => {
    expect(detect('Claude', 'noreply@anthropic.com')).toBe('claude')
  })

  it('recognizes Cursor agent attributions', () => {
    expect(detect('Cursor Agent', 'cursoragent@cursor.com')).toBe('cursor')
  })

  it('recognizes Copilot attributions', () => {
    expect(detect('GitHub Copilot', 'copilot@github.com')).toBe('copilot')
  })

  it('matches emails case-insensitively with padding', () => {
    expect(detect('whatever', '  NoReply@Anthropic.COM ')).toBe('claude')
  })

  it('lets the email win over a conflicting name', () => {
    expect(detect('Claude', 'cursoragent@cursor.com')).toBe('cursor')
  })

  it('never matches whole vendor domains — employees are humans', () => {
    expect(detect('Jane Doe', 'jane@anthropic.com')).toBeNull()
    expect(detect('John Roe', 'john@cursor.com')).toBeNull()
  })
})

describe('LlmVendorDetector.detect — by name', () => {
  it('recognizes bare and model-qualified Claude names', () => {
    expect(detect('Claude', '')).toBe('claude')
    expect(detect('claude code', 'bot@uvcs.example')).toBe('claude')
    expect(detect('Claude Opus 4.5', 'bot@uvcs.example')).toBe('claude')
    expect(detect('Claude Sonnet', '')).toBe('claude')
  })

  it('never tags humans who happen to be called Claude', () => {
    expect(detect('Claude Monet', 'claude@monet.fr')).toBeNull()
    expect(detect('Jean-Claude', '')).toBeNull()
    expect(detect('Claudette', '')).toBeNull()
  })

  it('recognizes Copilot name shapes', () => {
    expect(detect('Copilot', '')).toBe('copilot')
    expect(detect('GitHub Copilot', '')).toBe('copilot')
    expect(detect('copilot-swe-agent[bot]', '')).toBe('copilot')
  })

  it('recognizes Cursor name shapes', () => {
    expect(detect('Cursor Agent', '')).toBe('cursor')
    expect(detect('CursorAgent', '')).toBe('cursor')
    expect(detect('cursor[bot]', '')).toBe('cursor')
  })

  it('never tags unrelated names or empty identities', () => {
    expect(detect('Cursory Review', '')).toBeNull()
    expect(detect('Co-pilot Dan', '')).toBeNull()
    expect(detect('', '')).toBeNull()
  })
})

describe('LlmVendorDetector.avatarUrlFor', () => {
  it('serves the Claude icon from the mapped-email endpoint', () => {
    expect(llmVendors.avatarUrlFor('Claude', 'noreply@anthropic.com', 64)).toBe(
      'https://avatars.githubusercontent.com/u/e?email=noreply%40anthropic.com&s=64'
    )
  })

  it('serves the Copilot icon from its GitHub App integration id', () => {
    expect(llmVendors.avatarUrlFor('Copilot', '', 56)).toBe(
      'https://avatars.githubusercontent.com/in/1143301?s=56&v=4'
    )
  })

  it('serves the Cursor icon from the mapped-email endpoint', () => {
    expect(llmVendors.avatarUrlFor('Cursor Agent', '', 64)).toBe(
      'https://avatars.githubusercontent.com/u/e?email=cursoragent%40cursor.com&s=64'
    )
  })

  it('returns null for humans', () => {
    expect(llmVendors.avatarUrlFor('Daniel Peñalba', 'daniel.penalba@unity3d.com', 64)).toBeNull()
  })
})

describe('LlmVendorDetector — custom table', () => {
  it('is fully table-driven, so vendors are one entry away', () => {
    const detector = new LlmVendorDetector([
      {
        id: 'devin',
        label: 'Devin',
        emails: ['devin-ai-integration[bot]@users.noreply.github.com'],
        namePatterns: [/^devin(\[bot\])?$/i],
        avatarUrl: (size) => `https://example.com/devin?s=${size}`
      }
    ])
    expect(detector.detect('Devin', '')?.id).toBe('devin')
    expect(detector.detect('Claude', '')).toBeNull()
    expect(detector.avatarUrlFor('devin[bot]', '', 32)).toBe('https://example.com/devin?s=32')
  })
})
