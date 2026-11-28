import { describe, it, expect, vi } from 'vitest'

// The emojis row an inbound image URL names: a copy's row of the emoji's origin instance first, the
// server's emoji its members react with, else a row without a Group id; a copy of another
// instance's server never answers. An Undo matches every row the image may have named.

vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'harmony.test' }, config: { INSTANCE_DOMAIN: 'harmony.test' } }))

const { inboundEmojiRowId, inboundEmojiRowIds, emojiDomainForms } = await import('../utils/emojiOrigin.js')

function client(rows: any[]) {
  return {
    from: () => {
      const filters: Array<(r: any) => boolean> = []
      let n = Infinity
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q },
        not: (c: string, _o: string, v: unknown) => { filters.push((r) => (r[c] ?? null) !== v); return q },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q },
        order: () => q,
        limit: (k: number) => { n = k; return q },
        then: (res: any, rej: any) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, n), error: null }).then(res, rej),
      }
      return q
    },
  }
}

const URL_A = 'https://cdn.example/emojis/a.webp'

describe('inboundEmojiRowId', () => {
  it("answers the copy's row of the origin before a row without a Group id", async () => {
    const db = client([
      { id: 'plain', url: URL_A, ap_id: null, domain: 'h.test' },
      { id: 'copy', url: URL_A, ap_id: 'https://h.test/servers/x/emojis/1', domain: 'h.test' },
    ])
    expect(await inboundEmojiRowId(db, URL_A, 'h.test')).toBe('copy')
  })

  it('answers a row without a Group id, whatever its domain, when no copy of the origin holds the image', async () => {
    const db = client([
      { id: 'copy', url: URL_A, ap_id: 'https://h.test/servers/x/emojis/1', domain: 'h.test' },
      { id: 'plain', url: URL_A, ap_id: null, domain: 'm.test' },
    ])
    expect(await inboundEmojiRowId(db, URL_A, 'm.test')).toBe('plain')
  })

  it("answers a copy's row only for its Group's own instance, with or without a port", async () => {
    const db = client([{ id: 'copy', url: URL_A, ap_id: 'https://h.test:8443/servers/x/emojis/1', domain: 'h.test:8443' }])
    expect(await inboundEmojiRowId(db, URL_A, 'h.test:8443')).toBe('copy')
    expect(await inboundEmojiRowId(db, URL_A, 'evil.test')).toBeNull()
    expect(await inboundEmojiRowId(db, URL_A, null)).toBeNull()
    expect(emojiDomainForms('H.test:8443')).toEqual(['h.test:8443', 'h.test'])
  })

  it('answers the first of several rows of one URL instead of failing', async () => {
    const db = client([
      { id: 'one', url: URL_A, ap_id: null, domain: 'm.test' },
      { id: 'two', url: URL_A, ap_id: null, domain: 'n.test' },
    ])
    expect(await inboundEmojiRowId(db, URL_A, 'm.test')).toBe('one')
  })
})

describe('inboundEmojiRowIds', () => {
  it("lists the origin's copy rows, then the rows without a Group id, never another instance's copy", async () => {
    const db = client([
      { id: 'plain', url: URL_A, ap_id: null, domain: 'm.test' },
      { id: 'copy', url: URL_A, ap_id: 'https://h.test/servers/x/emojis/1', domain: 'h.test' },
      { id: 'evil', url: URL_A, ap_id: 'https://evil.test/servers/y/emojis/1', domain: 'evil.test' },
      { id: 'other', url: 'https://cdn.example/emojis/b.webp', ap_id: null, domain: 'h.test' },
    ])
    expect(await inboundEmojiRowIds(db, URL_A, 'h.test')).toEqual(['copy', 'plain'])
    expect(await inboundEmojiRowIds(db, URL_A, null)).toEqual(['plain'])
  })
})
