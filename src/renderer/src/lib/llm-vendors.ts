// LLM coding agents (Claude, Copilot, Cursor, …) author and co-author commits
// under identities that often resolve to no avatar anywhere — Gravatar has
// nothing for noreply@anthropic.com, and the GitHub user search can't find
// emails that aren't public on a profile. This detector recognizes those
// identities from the author name/email and serves each vendor's product
// icon from a deterministic URL, so attributions show a meaningful icon even
// with no account connected and on non-GitHub repos.

/** An LLM vendor GitGrove knows the product icon for. */
export interface LlmVendor {
  /** Stable identifier, e.g. 'claude'. */
  readonly id: string
  /** Human-readable product name. */
  readonly label: string
  /**
   * Exact author emails this vendor commits with, lowercased. Exact — never
   * whole domains: a human @anthropic.com employee is not Claude.
   */
  readonly emails: ReadonlyArray<string>
  /**
   * Author-name shapes, anchored and strict. Loose substring matching would
   * mislabel humans — Claude is a common French given name, so `Claude
   * Monet <claude@monet.fr>` must never get the Anthropic icon while plain
   * `Claude` (what Claude Code writes) must.
   */
  readonly namePatterns: ReadonlyArray<RegExp>
  /** The vendor's product icon at `size` pixels. */
  avatarUrl(size: number): string
}

/**
 * `/u/e?email=…` is only safe for emails GitHub demonstrably maps to an
 * account (an unknown email yields an identicon, not a 404) — fine here,
 * since entries below are exactly such emails.
 */
const emailEndpointUrl = (email: string) => (size: number) =>
  `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=${size}`

/** GitHub App installation icon (the `/in/<integration id>` namespace). */
const integrationUrl = (integrationId: number) => (size: number) =>
  `https://avatars.githubusercontent.com/in/${integrationId}?s=${size}&v=4`

/**
 * The built-in vendor table. Adding a vendor is one entry: its commit
 * emails, its strict name shapes, and where its icon lives.
 */
const KNOWN_VENDORS: ReadonlyArray<LlmVendor> = [
  {
    id: 'claude',
    label: 'Claude',
    emails: ['noreply@anthropic.com'],
    // "Claude", "Claude Code", "Claude Opus 4.5", "Claude Sonnet" — but not
    // "Claude Monet": the second word must be a model/product name.
    namePatterns: [/^claude(\s+(code|opus|sonnet|haiku)\b.*)?$/i],
    avatarUrl: emailEndpointUrl('noreply@anthropic.com')
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    emails: ['copilot@github.com'],
    // "Copilot", "GitHub Copilot", and the agent's committer identity
    // "copilot-swe-agent[bot]". Stealth emails (ID+Copilot@users.noreply…)
    // are already resolved upstream by githubEmailAvatarUrl.
    namePatterns: [/^(github\s+)?copilot(\[bot\])?$/i, /^copilot-swe-agent(\[bot\])?$/i],
    avatarUrl: integrationUrl(1143301)
  },
  {
    id: 'cursor',
    label: 'Cursor',
    emails: ['cursoragent@cursor.com'],
    namePatterns: [/^cursor\s*agent(\[bot\])?$/i, /^cursor(\[bot\])?$/i],
    avatarUrl: emailEndpointUrl('cursoragent@cursor.com')
  }
]

/**
 * Maps commit author identities to known LLM vendors. Email matches are
 * authoritative and win over name matches (an email proves the identity; a
 * name only suggests it). All matching is case-insensitive and trimmed.
 */
export class LlmVendorDetector {
  /** Exact lowercased email → vendor. */
  private readonly byEmail = new Map<string, LlmVendor>()

  constructor(private readonly vendors: ReadonlyArray<LlmVendor> = KNOWN_VENDORS) {
    for (const vendor of vendors) {
      for (const email of vendor.emails) this.byEmail.set(email.toLowerCase(), vendor)
    }
  }

  /** The vendor behind an author identity, or null for (presumed) humans. */
  detect(name: string, email: string): LlmVendor | null {
    const emailMatch = this.byEmail.get(email.trim().toLowerCase())
    if (emailMatch) return emailMatch
    const trimmedName = name.trim()
    if (!trimmedName) return null
    return this.vendors.find((v) => v.namePatterns.some((p) => p.test(trimmedName))) ?? null
  }

  /** Convenience: the detected vendor's icon URL at `size` px, or null. */
  avatarUrlFor(name: string, email: string, size: number): string | null {
    return this.detect(name, email)?.avatarUrl(size) ?? null
  }
}

/** The app-wide detector over the built-in vendor table. */
export const llmVendors = new LlmVendorDetector()
