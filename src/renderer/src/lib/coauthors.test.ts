import { describe, expect, it } from 'bun:test'

import { parseCoAuthors, stripCoAuthorTrailers } from './coauthors'

const author = { name: 'Daniel Peñalba', email: 'daniel@unity3d.com' }

describe('parseCoAuthors', () => {
  it('extracts name and email from a trailer', () => {
    const body = 'Fix the thing.\n\nCo-authored-by: Claude Opus <claude@anthropic.com>'
    expect(parseCoAuthors(body, author)).toEqual([
      { name: 'Claude Opus', email: 'claude@anthropic.com' }
    ])
  })

  it('keeps multiple co-authors in body order', () => {
    const body = [
      'Subject body',
      '',
      'Co-authored-by: Alice <alice@example.com>',
      'Co-authored-by: Bob <bob@example.com>'
    ].join('\n')
    expect(parseCoAuthors(body, author).map((p) => p.name)).toEqual(['Alice', 'Bob'])
  })

  it('matches the trailer key case-insensitively', () => {
    const body = 'co-AUTHORED-by: Alice <alice@example.com>'
    expect(parseCoAuthors(body, author)).toHaveLength(1)
  })

  it('handles CRLF line endings', () => {
    const body = 'Line one\r\nCo-authored-by: Alice <alice@example.com>\r\n'
    expect(parseCoAuthors(body, author)).toEqual([{ name: 'Alice', email: 'alice@example.com' }])
  })

  it('dedupes by email regardless of case and padding', () => {
    const body = [
      'Co-authored-by: Alice <alice@example.com>',
      'Co-authored-by: Alice Again < ALICE@EXAMPLE.COM >'
    ].join('\n')
    expect(parseCoAuthors(body, author)).toHaveLength(1)
  })

  it('never echoes the commit author back', () => {
    const body = 'Co-authored-by: Daniel Peñalba <DANIEL@unity3d.com>'
    expect(parseCoAuthors(body, author)).toEqual([])
  })

  it('accepts a trailer without an email, deduped by name', () => {
    const body = ['Co-authored-by: Just A Name', 'Co-authored-by: just a name'].join('\n')
    expect(parseCoAuthors(body, author)).toEqual([{ name: 'Just A Name', email: '' }])
  })

  it('uses the email as the display name when the name is empty', () => {
    const body = 'Co-authored-by: <alice@example.com>'
    expect(parseCoAuthors(body, author)).toEqual([
      { name: 'alice@example.com', email: 'alice@example.com' }
    ])
  })

  it('ignores empty trailers and unrelated lines', () => {
    const body = ['Co-authored-by:', 'Signed-off-by: Alice <alice@example.com>', 'Plain text'].join(
      '\n'
    )
    expect(parseCoAuthors(body, author)).toEqual([])
  })
})

describe('stripCoAuthorTrailers', () => {
  it('removes trailer lines and trims the remainder', () => {
    const body = 'Why the change matters.\n\nCo-authored-by: Alice <alice@example.com>\n'
    expect(stripCoAuthorTrailers(body)).toBe('Why the change matters.')
  })

  it('returns an empty string when the body is only trailers', () => {
    const body = 'Co-authored-by: Alice <alice@example.com>\r\nCo-authored-by: Bob <bob@b.com>'
    expect(stripCoAuthorTrailers(body)).toBe('')
  })

  it('leaves bodies without trailers untouched', () => {
    expect(stripCoAuthorTrailers('Just a body.')).toBe('Just a body.')
  })
})
