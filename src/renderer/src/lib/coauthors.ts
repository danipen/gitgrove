// Co-author support, parsed entirely in the renderer: the commit body already
// travels with every Commit (see LOG_FIELDS in main/git/read.ts), so trailers
// never need an extra git call or IPC round-trip.

import type { Commit } from '@shared/types'

export interface CommitPerson {
  name: string
  email: string
}

// Git trailer keys are case-insensitive; GitHub/GitLab write "Co-authored-by".
// The value is "Name <email>", but hand-written trailers sometimes omit the
// angle-bracketed email, so it's optional and dedupe falls back to the name.
const CO_AUTHOR_TRAILER = /^co-authored-by:\s*(.+?)\s*$/i

/**
 * Extract co-authors from a commit body's `Co-authored-by:` trailers, in
 * order, deduped by email (name when the email is missing) — and never
 * echoing the commit author back, even when a tool lists them as their own
 * co-author.
 */
export function parseCoAuthors(body: string, author?: CommitPerson): CommitPerson[] {
  const people: CommitPerson[] = []
  const seen = new Set<string>()
  if (author) seen.add(personKey(author))
  // Split on \r?\n: bodies written on Windows (core.autocrlf) carry CRLF.
  for (const line of body.split(/\r?\n/)) {
    const match = CO_AUTHOR_TRAILER.exec(line.trim())
    if (!match) continue
    const person = parsePerson(match[1])
    if (!person) continue
    const key = personKey(person)
    if (seen.has(key)) continue
    seen.add(key)
    people.push(person)
  }
  return people
}

/** Body without its Co-authored-by lines — the avatar stack carries that info. */
export function stripCoAuthorTrailers(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !CO_AUTHOR_TRAILER.test(line.trim()))
    .join('\n')
    .trim()
}

// Parsed once per Commit object: virtualized rows re-render on every scroll
// frame and the parse walks the whole body. Keyed weakly so paged-out commit
// arrays release their entries along with the objects themselves.
const coAuthorCache = new WeakMap<Commit, CommitPerson[]>()

/** Cached co-authors for a commit (author excluded). */
export function coAuthorsOf(commit: Commit): CommitPerson[] {
  let people = coAuthorCache.get(commit)
  if (!people) {
    people = parseCoAuthors(commit.body, {
      name: commit.authorName,
      email: commit.authorEmail
    })
    coAuthorCache.set(commit, people)
  }
  return people
}

function parsePerson(value: string): CommitPerson | null {
  const angled = /^(.*?)\s*<([^<>]*)>\s*$/.exec(value)
  const name = (angled ? angled[1] : value).trim()
  const email = (angled ? angled[2] : '').trim()
  if (!name && !email) return null
  return { name: name || email, email }
}

function personKey(person: CommitPerson): string {
  return (person.email || person.name).trim().toLowerCase()
}
