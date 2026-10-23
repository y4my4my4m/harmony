import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ActivityPub conformance: the stored activity types against the database check, forwarded
// activities confirmed by their origin, subdomain blocks, the delivery retry schedule, the
// Person actor (context, url, indexable, field values) and inbound long-form objects.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/urlUtils.js', () => ({
  getFullAvatarUrl: vi.fn((url: string | null) => url || null),
  getFullBannerUrl: vi.fn((url: string | null) => url || null),
}))
const blockedRows = vi.hoisted(() => ({ rows: [] as Array<{ domain: string }> }))
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    from: () => {
      const q: any = { select: () => q, eq: () => Promise.resolve({ data: blockedRows.rows, error: null }) }
      return q
    },
  })),
}))

const { STORED_ACTIVITY_TYPES, isStoredActivityType } = await import('../activitypub/activityTypes.js')
const { confirmForwardedActivity } = await import('../activitypub/forwardedActivity.js')
const { BlockedInstancesCache } = await import('../services/BlockedInstancesCache.js')
const { retryDelayMs, DELIVERY_MAX_ATTEMPTS } = await import('../activitypub/DeliveryQueue.js')
const { profileToActor, fieldValueToHtml } = await import('../activitypub/converters/toActivityPub.js')
const { asNoteObject, isPostObjectType, noteToContent, objectLanguage, extractMediaAttachments } = await import('../activitypub/converters/fromActivityPub.js')

const textOf = (parts: any[]) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('')

describe('stored activity types', () => {
  it('are the ap_activities_valid_type check of the latest migration that sets it, plus EmojiReact', () => {
    const dir = path.resolve(__dirname, '../../../db_schema/migrations')
    const latest = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().reverse()
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
      .find((sql) => sql.includes('ADD CONSTRAINT ap_activities_valid_type'))!
    const check = latest.slice(latest.indexOf('ADD CONSTRAINT ap_activities_valid_type'))
    const list = check.slice(check.indexOf('('), check.indexOf('))'))
    const types = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect([...STORED_ACTIVITY_TYPES].sort()).toEqual([...types, 'EmojiReact'].sort())
  })

  it('leave out what other software sends and Harmony does not implement', () => {
    for (const type of ['View', 'LikeRequest', 'ReplyRequest', 'Dislike', 'ChatMessage', 'Read', undefined, ['Create']]) {
      expect(isStoredActivityType(type)).toBe(false)
    }
    expect(isStoredActivityType('EmojiReact')).toBe(true)
  })
})

describe('forwarded activities', () => {
  const ACTOR = 'https://origin.test/users/ann'
  const NOTE = 'https://origin.test/users/ann/statuses/1'
  const served = new Map<string, { status: number; doc?: any }>()
  const stored = new Map<string, string>()
  const fetched: string[] = []
  const deps = {
    fetchDoc: async (url: string, onStatus?: (s: number) => void) => {
      fetched.push(url)
      const hit = served.get(url) ?? { status: 404 }
      onStatus?.(hit.status)
      return hit.status === 200 ? { doc: hit.doc, finalUrl: url } : null
    },
    storedPostVisibility: async (apId: string) => stored.get(apId) ?? null,
  }
  const create = (object: any) => ({ id: `${NOTE}/activity`, type: 'Create', actor: ACTOR, object })

  beforeEach(() => {
    served.clear()
    stored.clear()
    fetched.length = 0
  })

  it('processes the Create with the object its origin serves, never the forwarded body', async () => {
    served.set(NOTE, { status: 200, doc: { id: NOTE, type: 'Note', attributedTo: ACTOR, content: '<p>real</p>', to: ['https://www.w3.org/ns/activitystreams#Public'] } })
    const out: any = await confirmForwardedActivity(create({ id: NOTE, type: 'Note', attributedTo: ACTOR, content: '<p>forged</p>' }), ACTOR, deps)
    expect(out.refused).toBeUndefined()
    expect(out.activity.object.content).toBe('<p>real</p>')
    expect(out.activity.actor).toBe(ACTOR)
    expect(out.activity.to).toEqual(['https://www.w3.org/ns/activitystreams#Public'])
    expect(fetched).toEqual([NOTE])
  })

  it('refuses a Create whose served object belongs to another actor', async () => {
    served.set(NOTE, { status: 200, doc: { id: NOTE, type: 'Note', attributedTo: 'https://origin.test/users/bob' } })
    expect(await confirmForwardedActivity(create(NOTE), ACTOR, deps)).toHaveProperty('refused')
  })

  it('refuses an object or activity id off the actor\'s host without fetching', async () => {
    expect(await confirmForwardedActivity(create('https://elsewhere.test/notes/1'), ACTOR, deps)).toHaveProperty('refused')
    expect(await confirmForwardedActivity({ ...create(NOTE), id: 'https://forwarder.test/a/1' }, ACTOR, deps)).toHaveProperty('refused')
    expect(fetched).toEqual([])
  })

  it('refuses an object its origin does not serve', async () => {
    expect(await confirmForwardedActivity(create(NOTE), ACTOR, deps)).toHaveProperty('refused')
  })

  it('takes an Update of the actor itself from the served actor document', async () => {
    served.set(ACTOR, { status: 200, doc: { id: ACTOR, type: 'Person', name: 'Ann' } })
    const out: any = await confirmForwardedActivity({ id: `${ACTOR}#updates/1`, type: 'Update', actor: ACTOR, object: { id: ACTOR, name: 'Forged' } }, ACTOR, deps)
    expect(out.activity.object.name).toBe('Ann')
  })

  it('takes an Announce only as its origin serves it, naming a post', async () => {
    const id = `${NOTE}/reblog`
    served.set(id, { status: 200, doc: { id, type: 'Announce', actor: ACTOR, object: 'https://third.test/notes/9' } })
    const out: any = await confirmForwardedActivity({ id, type: 'Announce', actor: ACTOR, object: 'https://third.test/notes/forged' }, ACTOR, deps)
    expect(out.activity.object).toBe('https://third.test/notes/9')

    served.set(id, { status: 200, doc: { id, type: 'Announce', actor: ACTOR, object: { type: 'Create', actor: 'https://x.test/u' } } })
    expect(await confirmForwardedActivity({ id, type: 'Announce', actor: ACTOR, object: 'x' }, ACTOR, deps)).toHaveProperty('refused')
  })

  it('takes a Delete of a stored public post its origin no longer serves', async () => {
    stored.set(NOTE, 'public')
    served.set(NOTE, { status: 410 })
    const out: any = await confirmForwardedActivity({ id: `${NOTE}#delete`, type: 'Delete', actor: ACTOR, object: { id: NOTE, type: 'Tombstone' } }, ACTOR, deps)
    expect(out.activity).toEqual({ id: `${NOTE}#delete`, type: 'Delete', actor: ACTOR, object: NOTE })
  })

  it('refuses a Delete the origin contradicts, or whose 404 proves nothing', async () => {
    const del = { id: `${NOTE}#delete`, type: 'Delete', actor: ACTOR, object: NOTE }
    stored.set(NOTE, 'public')
    served.set(NOTE, { status: 200, doc: { id: NOTE, type: 'Note', attributedTo: ACTOR } })
    expect(await confirmForwardedActivity(del, ACTOR, deps)).toHaveProperty('refused')

    // A followers-only post is not served to this instance's actor: 404 is no proof.
    stored.set(NOTE, 'followers')
    served.set(NOTE, { status: 404 })
    expect(await confirmForwardedActivity(del, ACTOR, deps)).toHaveProperty('refused')
    stored.delete(NOTE)
    expect(await confirmForwardedActivity(del, ACTOR, deps)).toHaveProperty('refused')
  })

  it('takes a forwarded Delete of the actor only on 410 Gone', async () => {
    const del = { id: `${ACTOR}#delete`, type: 'Delete', actor: ACTOR, object: ACTOR }
    served.set(ACTOR, { status: 404 })
    expect(await confirmForwardedActivity(del, ACTOR, deps)).toHaveProperty('refused')
    served.set(ACTOR, { status: 410 })
    expect(await confirmForwardedActivity(del, ACTOR, deps)).toHaveProperty('activity')
  })

  it('refuses every other type', async () => {
    for (const type of ['Like', 'Follow', 'Undo', 'Flag', 'Move', 'Block']) {
      expect(await confirmForwardedActivity({ id: `${ACTOR}/x`, type, actor: ACTOR, object: NOTE }, ACTOR, deps)).toHaveProperty('refused')
    }
    expect(fetched).toEqual([])
  })
})

describe('domain blocks', () => {
  it('cover the domain and its subdomains, nothing else', async () => {
    blockedRows.rows = [{ domain: 'Example.com' }]
    await BlockedInstancesCache.refresh()
    expect(BlockedInstancesCache.isBlocked('example.com')).toBe(true)
    expect(BlockedInstancesCache.isBlocked('a.example.com')).toBe(true)
    expect(BlockedInstancesCache.isBlocked('A.B.EXAMPLE.COM')).toBe(true)
    expect(BlockedInstancesCache.isBlocked('example.com.')).toBe(true)
    expect(BlockedInstancesCache.isBlocked('notexample.com')).toBe(false)
    expect(BlockedInstancesCache.isBlocked('example.com.evil.test')).toBe(false)
    expect(BlockedInstancesCache.isBlocked('com')).toBe(false)
    blockedRows.rows = []
    await BlockedInstancesCache.refresh()
    expect(BlockedInstancesCache.isBlocked('a.example.com')).toBe(false)
  })
})

describe('delivery retry schedule', () => {
  it('doubles from 5 minutes to at most 12 hours and spans about five days', () => {
    expect([1, 2, 3, 8, 9, 16].map((n) => retryDelayMs(n) / 60_000)).toEqual([5, 10, 20, 640, 720, 720])
    let total = 0
    for (let attempts = 1; attempts < DELIVERY_MAX_ATTEMPTS; attempts++) total += retryDelayMs(attempts)
    expect(total / 86_400_000).toBeGreaterThan(4.5)
    expect(total / 86_400_000).toBeLessThan(5)
  })
})

describe('Person actor', () => {
  const actor = profileToActor({
    username: 'alice',
    federation_discoverable: false,
    profile_fields: [
      { name: 'Site', value: '<a href="https://alice.example/?a=1&amp;b=2" target="_blank" rel="me nofollow noopener noreferrer">https://alice.example/?a=1&amp;b=2</a>' },
      { name: 'Pronouns', value: 'she/her &amp; <b>they</b>' },
      { name: 'Bad', value: '<a href="javascript:alert(1)" onclick="x()">click</a><script>alert(2)</script>' },
    ],
  })

  it('names its page in the web app as url', () => {
    expect(actor.url).toBe('https://harmony.test/social/profile/alice')
    expect(actor.id).toBe('https://harmony.test/users/alice')
  })

  it('defines every extension term it uses in its context', () => {
    const terms = actor['@context'][2]
    expect(terms).toMatchObject({
      manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
      toot: 'http://joinmastodon.org/ns#',
      featured: { '@id': 'toot:featured', '@type': '@id' },
      discoverable: 'toot:discoverable',
      indexable: 'toot:indexable',
      Emoji: 'toot:Emoji',
      schema: 'http://schema.org#',
      PropertyValue: 'schema:PropertyValue',
      value: 'schema:value',
      alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
      movedTo: { '@id': 'as:movedTo', '@type': '@id' },
      harmony: 'https://har.mony.lol/ns#',
    })
  })

  it('carries indexable with discoverable, from the same setting', () => {
    expect(actor.discoverable).toBe(false)
    expect(actor.indexable).toBe(false)
    const open = profileToActor({ username: 'bob', federation_discoverable: true })
    expect([open.discoverable, open.indexable]).toEqual([true, true])
  })

  it('sends field values as inline HTML, links rel="me", stored markup reduced to text', () => {
    expect(actor.attachment.map((f: any) => f.value)).toEqual([
      '<a href="https://alice.example/?a=1&amp;b=2" rel="me nofollow noopener noreferrer" target="_blank">https://alice.example/?a=1&amp;b=2</a>',
      'she/her &amp; they',
      'javascript:alert(1) alert(2)',
    ])
    expect(actor.attachment.map((f: any) => f.name)).toEqual(['Site', 'Pronouns', 'Bad'])
  })

  it('links a URL typed as plain text and keeps code points outside Unicode encoded', () => {
    expect(fieldValueToHtml('see https://x.example/a')).toBe('see <a href="https://x.example/a" rel="me nofollow noopener noreferrer" target="_blank">https://x.example/a</a>')
    expect(fieldValueToHtml('&#99999999; &#x1F600;')).toBe('&amp;#99999999; 😀')
  })
})

describe('inbound long-form objects', () => {
  it('reads a Lemmy Page: title, body, link', () => {
    const page = asNoteObject({
      id: 'https://lemmy.test/post/1', type: 'Page', name: 'A <title>', content: '<p>body</p>',
      attachment: [{ type: 'Link', href: 'https://news.test/story' }],
      language: { identifier: 'de', name: 'Deutsch' },
    })
    expect(textOf(noteToContent(page))).toContain('A <title>')
    expect(noteToContent(page).some((p: any) => p.type === 'url' && p.url === 'https://news.test/story')).toBe(true)
    expect(textOf(noteToContent(page))).toContain('body')
    expect(objectLanguage(page)).toBe('de')
    expect(page.type).toBe('Page')
  })

  it('reads an Article with its name; its summary is an excerpt, not a content warning', () => {
    const article = asNoteObject({ id: 'https://blog.test/1', type: 'Article', name: 'Title', summary: 'excerpt', content: '<p>text</p>' })
    expect(textOf(noteToContent(article)).startsWith('Title')).toBe(true)
    expect(article.summary).toBeUndefined()
    expect(asNoteObject({ type: 'Article', name: 'T', summary: 'cw', sensitive: true, content: 'x' }).summary).toBe('cw')
  })

  it('reads a PeerTube Video: name, page URL and the largest thumbnail', () => {
    const video = asNoteObject({
      id: 'https://tube.test/videos/watch/1', type: 'Video', name: 'My video', mediaType: 'text/markdown',
      content: 'description with <b>markup</b>\nsecond line',
      url: [
        { type: 'Link', mediaType: 'application/x-mpegURL', href: 'https://tube.test/hls/1.m3u8' },
        { type: 'Link', mediaType: 'text/html', href: 'https://tube.test/w/1' },
      ],
      icon: [
        { type: 'Image', url: 'https://tube.test/small.jpg', mediaType: 'image/jpeg', width: 280, height: 157 },
        { type: 'Image', url: 'https://tube.test/big.jpg', mediaType: 'image/jpeg', width: 1280, height: 720 },
      ],
    })
    const parts = noteToContent(video)
    expect(textOf(parts)).toContain('My video')
    expect(textOf(parts)).toContain('description with <b>markup</b>\nsecond line')
    expect(parts.some((p: any) => p.type === 'url' && p.url === 'https://tube.test/w/1')).toBe(true)
    expect(extractMediaAttachments(video.attachment)).toMatchObject([
      { url: 'https://tube.test/big.jpg', mediaType: 'image/jpeg', description: 'My video', width: 1280 },
    ])
  })

  it('falls back to contentMap without content: the entry of its language, else the first non-empty one', () => {
    const note = asNoteObject({ type: 'Note', contentMap: { en: '<p>hello</p>', fr: '<p>bonjour</p>' }, language: 'fr' })
    expect(objectLanguage(note)).toBe('en')
    expect(textOf(noteToContent(note))).toBe('hello')
    expect(textOf(noteToContent(asNoteObject({ type: 'Note', contentMap: { und: '', ja: '<p>こんにちは</p>' } })))).toBe('こんにちは')
  })

  it('reads the language from contentMap or language, BCP 47 only', () => {
    expect(objectLanguage({ contentMap: { 'pt-BR': 'x' } })).toBe('pt-BR')
    expect(objectLanguage({ contentMap: { und: 'x' } })).toBeNull()
    expect(objectLanguage({ language: 'not a tag' })).toBeNull()
    expect(objectLanguage({})).toBeNull()
  })

  it('stores Note, Article, Page, Video and Question; leaves other objects as given', () => {
    expect(['Note', 'Article', 'Page', 'Video', 'Question'].every(isPostObjectType)).toBe(true)
    expect(['ChatThread', 'Event', 'Image', undefined].some(isPostObjectType)).toBe(false)
    const thread = { type: 'ChatThread', name: 'x' }
    expect(asNoteObject(thread)).toBe(thread)
    const note = { type: 'Note', content: '<p>a</p>' }
    expect(asNoteObject(note)).toBe(note)
  })
})
