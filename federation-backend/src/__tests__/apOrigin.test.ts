import { describe, it, expect, vi } from 'vitest'
import { fetchAuthoritativeDocument, sameOrigin, urlHost } from '../utils/apOrigin.js'

describe('urlHost / sameOrigin', () => {
  it('compares lowercased host and port', () => {
    expect(urlHost('https://Mastodon.Social/users/a')).toBe('mastodon.social')
    expect(sameOrigin('https://a.test/x', 'https://A.test/y')).toBe(true)
    expect(sameOrigin('https://a.test/x', 'https://a.test:8443/y')).toBe(false)
    expect(sameOrigin('https://a.test/x', 'https://b.test/x')).toBe(false)
  })

  it('rejects non-http values', () => {
    expect(urlHost('javascript:alert(1)')).toBeNull()
    expect(sameOrigin(undefined, undefined)).toBe(false)
    expect(sameOrigin({ id: 'https://a.test' }, 'https://a.test')).toBe(false)
  })
})

describe('fetchAuthoritativeDocument', () => {
  it('returns a document whose id is on the fetched host', async () => {
    const fetchJson = vi.fn(async () => ({ id: 'https://a.test/notes/1' }))
    await expect(fetchAuthoritativeDocument('https://a.test/@x/1', fetchJson)).resolves.toEqual({ id: 'https://a.test/notes/1' })
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  it('re-fetches a foreign id from its own host', async () => {
    const docs: Record<string, any> = {
      'https://evil.test/1': { id: 'https://a.test/notes/1', content: 'forged' },
      'https://a.test/notes/1': { id: 'https://a.test/notes/1', content: 'real' },
    }
    const doc = await fetchAuthoritativeDocument('https://evil.test/1', async (u) => docs[u] ?? null)
    expect(doc.content).toBe('real')
  })

  it('drops a document whose id does not survive the re-fetch', async () => {
    const docs: Record<string, any> = {
      'https://evil.test/1': { id: 'https://a.test/notes/1' },
      'https://a.test/notes/1': { id: 'https://a.test/notes/2' },
    }
    await expect(fetchAuthoritativeDocument('https://evil.test/1', async (u) => docs[u] ?? null)).resolves.toBeNull()
  })

  it('drops a document without an id', async () => {
    await expect(fetchAuthoritativeDocument('https://a.test/1', async () => ({ type: 'Note' }))).resolves.toBeNull()
  })
})
