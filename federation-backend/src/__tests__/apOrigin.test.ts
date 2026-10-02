import { describe, it, expect, vi } from 'vitest'
import {
  actorOwnsKeys,
  fetchActorById,
  fetchAuthoritativeDocument,
  isActivityPubContentType,
  readApDocument,
  sameOrigin,
  urlHost,
  type FetchedDocument,
} from '../utils/apOrigin.js'

// Served documents keyed by request URL: `doc` and the URL it ends up at.
const server = (docs: Record<string, { doc: any; finalUrl?: string }>) =>
  vi.fn(async (url: string): Promise<FetchedDocument | null> =>
    docs[url] ? { doc: docs[url].doc, finalUrl: docs[url].finalUrl ?? url } : null)

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

describe('isActivityPubContentType', () => {
  it('accepts activity+json and ld+json with the ActivityStreams profile', () => {
    expect(isActivityPubContentType('application/activity+json')).toBe(true)
    expect(isActivityPubContentType('application/activity+json; charset=utf-8')).toBe(true)
    expect(isActivityPubContentType('application/ld+json; profile="https://www.w3.org/ns/activitystreams"')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(isActivityPubContentType('application/json')).toBe(false)
    expect(isActivityPubContentType('application/ld+json')).toBe(false)
    expect(isActivityPubContentType('text/html')).toBe(false)
    expect(isActivityPubContentType(null)).toBe(false)
  })
})

describe('readApDocument', () => {
  it('keeps the served URL and refuses a non-ActivityPub media type', async () => {
    const ok = new Response(JSON.stringify({ id: 'https://a.test/users/x' }), {
      headers: { 'content-type': 'application/activity+json' },
    })
    Object.defineProperty(ok, 'url', { value: 'https://a.test/users/x' })
    await expect(readApDocument(ok, 'https://a.test/@x')).resolves.toEqual({
      doc: { id: 'https://a.test/users/x' }, finalUrl: 'https://a.test/users/x',
    })

    const upload = new Response(JSON.stringify({ id: 'https://a.test/users/x' }), {
      headers: { 'content-type': 'application/json' },
    })
    await expect(readApDocument(upload, 'https://a.test/files/x.json')).resolves.toBeNull()
  })
})

describe('fetchAuthoritativeDocument', () => {
  it('keeps a document served from its own id', async () => {
    const fetchDoc = server({ 'https://a.test/notes/1': { doc: { id: 'https://a.test/notes/1' } } })
    await expect(fetchAuthoritativeDocument('https://a.test/notes/1', fetchDoc)).resolves.toEqual({ id: 'https://a.test/notes/1' })
    expect(fetchDoc).toHaveBeenCalledTimes(1)
  })

  it('re-fetches a same-host document served from another URL', async () => {
    const fetchDoc = server({
      'https://a.test/@x/1': { doc: { id: 'https://a.test/notes/1', content: 'copy' } },
      'https://a.test/notes/1': { doc: { id: 'https://a.test/notes/1', content: 'real' } },
    })
    const doc = await fetchAuthoritativeDocument('https://a.test/@x/1', fetchDoc)
    expect(doc.content).toBe('real')
    expect(fetchDoc).toHaveBeenCalledTimes(2)
  })

  it('re-fetches a foreign id from its own host', async () => {
    const fetchDoc = server({
      'https://evil.test/1': { doc: { id: 'https://a.test/notes/1', content: 'forged' } },
      'https://a.test/notes/1': { doc: { id: 'https://a.test/notes/1', content: 'real' } },
    })
    const doc = await fetchAuthoritativeDocument('https://evil.test/1', fetchDoc)
    expect(doc.content).toBe('real')
  })

  it('drops a document whose id does not survive the re-fetch', async () => {
    const fetchDoc = server({
      'https://evil.test/1': { doc: { id: 'https://a.test/notes/1' } },
      'https://a.test/notes/1': { doc: { id: 'https://a.test/notes/2' } },
    })
    await expect(fetchAuthoritativeDocument('https://evil.test/1', fetchDoc)).resolves.toBeNull()
  })

  it('drops a document that redirects away from its id', async () => {
    const fetchDoc = server({
      'https://a.test/users/bob': { doc: { id: 'https://a.test/users/bob', publicKey: 'forged' }, finalUrl: 'https://a.test/uploads/x.json' },
    })
    await expect(fetchAuthoritativeDocument('https://a.test/users/bob', fetchDoc)).resolves.toBeNull()
  })

  it('drops a document without an id', async () => {
    const fetchDoc = server({ 'https://a.test/1': { doc: { type: 'Note' } } })
    await expect(fetchAuthoritativeDocument('https://a.test/1', fetchDoc)).resolves.toBeNull()
  })
})

describe('fetchActorById', () => {
  const BOB = 'https://a.test/users/bob'
  const key = (owner: string) => ({ id: `${owner}#main-key`, owner, publicKeyPem: 'PEM' })

  it('keeps an actor served from its id with a key it owns', async () => {
    const fetchDoc = server({ [BOB]: { doc: { id: BOB, publicKey: key(BOB) } } })
    await expect(fetchActorById(BOB, fetchDoc)).resolves.toMatchObject({ id: BOB })
  })

  it('refuses a same-host document naming another actor, without re-fetching', async () => {
    const upload = 'https://a.test/uploads/evil.json'
    const fetchDoc = server({
      [upload]: { doc: { id: BOB, publicKey: key(BOB) } },
      [BOB]: { doc: { id: BOB, publicKey: key(BOB) } },
    })
    await expect(fetchActorById(upload, fetchDoc)).resolves.toBeNull()
    expect(fetchDoc).toHaveBeenCalledTimes(1)
  })

  it('refuses a key owned by another actor', async () => {
    const fetchDoc = server({ [BOB]: { doc: { id: BOB, publicKey: key('https://a.test/users/alice') } } })
    await expect(fetchActorById(BOB, fetchDoc)).resolves.toBeNull()
  })
})

describe('actorOwnsKeys', () => {
  it('requires owner === id and a key id on the actor host', () => {
    const id = 'https://a.test/users/x'
    expect(actorOwnsKeys({ id })).toBe(true)
    expect(actorOwnsKeys({ id, publicKey: { id: `${id}#k`, owner: id } })).toBe(true)
    expect(actorOwnsKeys({ id, publicKey: [{ id: `${id}#k`, owner: id }, { id: 'https://b.test/k', owner: id }] })).toBe(false)
    expect(actorOwnsKeys({ id, publicKey: { id: `${id}#k` } })).toBe(false)
  })
})
