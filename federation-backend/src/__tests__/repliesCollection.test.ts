import { describe, it, expect, vi } from 'vitest'

// Walking a remote Note's replies collection and storing what it lists.

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { walkRepliesCollection, crawlReplies, storeReplies } = await import('../activitypub/repliesCollection.js')
type ReplyStore = import('../activitypub/repliesCollection.js').ReplyStore

const POST = 'https://mastodon.test/users/strypey/statuses/1'
const REPLIES = `${POST}/replies`
const PAGE_OTHERS = `${REPLIES}?only_other_accounts=true&page=true`
const PAGE_OTHERS_2 = `${REPLIES}?min_id=200&only_other_accounts=true&page=true`
const PAGE_OTHERS_3 = `${REPLIES}?min_id=300&only_other_accounts=true&page=true`

const note = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'Note', attributedTo: id.replace(/\/statuses\/.*/, ''), content: '<p>reply</p>', inReplyTo: POST, ...extra,
})

/** A Mastodon status: the first page embedded with the author's own replies. */
const mastodonNote = {
  id: POST,
  type: 'Note',
  replies: {
    id: REPLIES,
    type: 'Collection',
    first: {
      type: 'CollectionPage',
      partOf: REPLIES,
      next: PAGE_OTHERS,
      items: [note('https://mastodon.test/users/strypey/statuses/2')],
    },
  },
}

/** Pages of other accounts' replies: local ones embedded, remote ones as URIs. */
const pages: Record<string, any> = {
  [PAGE_OTHERS]: {
    id: PAGE_OTHERS, type: 'CollectionPage', partOf: REPLIES, next: PAGE_OTHERS_2,
    items: [
      'https://pleroma.test/objects/a1',
      note('https://mastodon.test/users/kiwi/statuses/3'),
      { type: 'Create', object: 'https://misskey.test/notes/m1' },
    ],
  },
  [PAGE_OTHERS_2]: {
    id: PAGE_OTHERS_2, type: 'CollectionPage', partOf: REPLIES, next: PAGE_OTHERS_3,
    items: ['https://pleroma.test/objects/a1', 'https://gts.test/users/x/statuses/4'],
  },
  [PAGE_OTHERS_3]: {
    id: PAGE_OTHERS_3, type: 'CollectionPage', partOf: REPLIES,
    items: ['https://blocked.test/users/y/statuses/5', POST],
  },
}

function fetcher(docs: Record<string, any> = pages) {
  return vi.fn(async (url: string) => (docs[url] ? { doc: docs[url], finalUrl: url } : null))
}

const later = () => Date.now() + 60_000

describe('walkRepliesCollection', () => {
  it('follows the embedded first page into other accounts\' pages', async () => {
    const fetchDoc = fetcher()
    const walk = await walkRepliesCollection(mastodonNote.replies, POST, fetchDoc,
      { maxPages: 5, maxReplies: 200, deadline: later() })

    expect(walk.refs.map((r) => r.id)).toEqual([
      'https://mastodon.test/users/strypey/statuses/2',
      'https://pleroma.test/objects/a1',
      'https://mastodon.test/users/kiwi/statuses/3',
      'https://misskey.test/notes/m1',
      'https://gts.test/users/x/statuses/4',
      'https://blocked.test/users/y/statuses/5',
    ])
    expect(walk.pages).toBe(3)
    expect(walk.truncated).toBe(false)
    expect(fetchDoc.mock.calls.map((c) => c[0])).toEqual([PAGE_OTHERS, PAGE_OTHERS_2, PAGE_OTHERS_3])
  })

  it('keeps embedded replies from the page\'s host and only the id of others', async () => {
    const walk = await walkRepliesCollection(mastodonNote.replies, POST, fetcher(),
      { maxPages: 5, maxReplies: 200, deadline: later() })
    const byId = new Map(walk.refs.map((r) => [r.id, r]))
    expect(byId.get('https://mastodon.test/users/kiwi/statuses/3')?.object?.type).toBe('Note')
    expect(byId.get('https://pleroma.test/objects/a1')?.object).toBeUndefined()

    const forged = {
      [PAGE_OTHERS]: { type: 'CollectionPage', items: [note('https://pleroma.test/objects/forged')] },
    }
    const walk2 = await walkRepliesCollection(mastodonNote.replies, POST, fetcher(forged),
      { maxPages: 5, maxReplies: 200, deadline: later() })
    expect(walk2.refs.find((r) => r.id === 'https://pleroma.test/objects/forged')?.object).toBeUndefined()
  })

  it('stops at the page limit', async () => {
    const walk = await walkRepliesCollection(mastodonNote.replies, POST, fetcher(),
      { maxPages: 1, maxReplies: 200, deadline: later() })
    expect(walk.pages).toBe(1)
    expect(walk.truncated).toBe(true)
    expect(walk.refs).toHaveLength(4)
  })

  it('stops at the reply limit without fetching further pages', async () => {
    const fetchDoc = fetcher()
    const walk = await walkRepliesCollection(mastodonNote.replies, POST, fetchDoc,
      { maxPages: 5, maxReplies: 2, deadline: later() })
    expect(walk.refs).toHaveLength(2)
    expect(walk.truncated).toBe(true)
    expect(fetchDoc).toHaveBeenCalledTimes(1)
  })

  it('starts no request after the deadline', async () => {
    const fetchDoc = fetcher()
    const walk = await walkRepliesCollection(mastodonNote.replies, POST, fetchDoc,
      { maxPages: 5, maxReplies: 200, deadline: Date.now() - 1 })
    expect(fetchDoc).not.toHaveBeenCalled()
    expect(walk.refs).toHaveLength(1)
    expect(walk.truncated).toBe(true)
  })

  it('reads a collection named by URL and its first page (Pleroma)', async () => {
    const id = 'https://pleroma.test/objects/root'
    const docs = {
      [`${id}/replies`]: { id: `${id}/replies`, type: 'OrderedCollection', first: `${id}/replies?page=1` },
      [`${id}/replies?page=1`]: {
        id: `${id}/replies?page=1`, type: 'OrderedCollectionPage',
        orderedItems: ['https://pleroma.test/objects/r1', 'https://mastodon.test/users/a/statuses/9'],
      },
    }
    const walk = await walkRepliesCollection(`${id}/replies`, id, fetcher(docs),
      { maxPages: 5, maxReplies: 200, deadline: later() })
    expect(walk.refs.map((r) => r.id)).toEqual(['https://pleroma.test/objects/r1', 'https://mastodon.test/users/a/statuses/9'])
    expect(walk.pages).toBe(2)
  })

  it('does not leave the post\'s host and stops on a loop', async () => {
    const offHost = {
      [PAGE_OTHERS]: { id: PAGE_OTHERS, type: 'CollectionPage', next: 'https://elsewhere.test/replies?page=2', items: ['https://a.test/1'] },
    }
    const fetchDoc = fetcher(offHost)
    const walk = await walkRepliesCollection(mastodonNote.replies, POST, fetchDoc,
      { maxPages: 5, maxReplies: 200, deadline: later() })
    expect(fetchDoc).toHaveBeenCalledTimes(1)
    expect(walk.truncated).toBe(false)

    const loop = {
      [PAGE_OTHERS]: { id: PAGE_OTHERS, type: 'CollectionPage', next: PAGE_OTHERS, items: ['https://a.test/1'] },
    }
    const fetchLoop = fetcher(loop)
    await walkRepliesCollection(mastodonNote.replies, POST, fetchLoop, { maxPages: 5, maxReplies: 200, deadline: later() })
    expect(fetchLoop).toHaveBeenCalledTimes(1)
  })
})

function memoryStore(held: string[] = [], blockedHosts: string[] = []) {
  const stored: string[] = []
  const store: ReplyStore = {
    isBlockedHost: (host) => blockedHosts.includes(host),
    existing: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => held.includes(id)))),
    storeById: vi.fn(async (id: string) => {
      if (id.includes('suspended')) return 'skipped' as const
      stored.push(id)
      return 'stored' as const
    }),
    storeObject: vi.fn(async (object: any) => {
      stored.push(object.id)
      return 'stored' as const
    }),
  }
  return { store, stored }
}

describe('crawlReplies', () => {
  it('stores each listed reply once, embedded ones without a fetch', async () => {
    const { store, stored } = memoryStore(['https://gts.test/users/x/statuses/4'], ['blocked.test'])
    const crawl = await crawlReplies(mastodonNote, fetcher(), store, { maxPages: 5, maxReplies: 200, deadline: later() })

    expect(crawl).toMatchObject({ status: 'ok', found: 6, stored: 4, existing: 1, skipped: 1, pages: 3, truncated: false })
    expect(stored.sort()).toEqual([
      'https://mastodon.test/users/kiwi/statuses/3',
      'https://mastodon.test/users/strypey/statuses/2',
      'https://misskey.test/notes/m1',
      'https://pleroma.test/objects/a1',
    ])
    expect(store.storeObject).toHaveBeenCalledTimes(2)
    expect(store.storeById).not.toHaveBeenCalledWith('https://blocked.test/users/y/statuses/5')
    expect(store.storeById).not.toHaveBeenCalledWith('https://gts.test/users/x/statuses/4')
  })

  it('reports a Note without a replies collection', async () => {
    const { store } = memoryStore()
    const crawl = await crawlReplies({ id: 'https://misskey.test/notes/1', type: 'Note' }, fetcher(), store,
      { maxPages: 5, maxReplies: 200, deadline: later() })
    expect(crawl.status).toBe('no_collection')
    expect(store.existing).not.toHaveBeenCalled()
  })

  it('counts a refused reply as skipped', async () => {
    const { store } = memoryStore()
    const counts = await storeReplies([{ id: 'https://a.test/suspended/1' }, { id: 'https://a.test/ok/2' }], store, later())
    expect(counts).toEqual({ stored: 1, existing: 0, skipped: 1, truncated: false })
  })

  it('starts no store after the deadline', async () => {
    const { store } = memoryStore()
    const counts = await storeReplies([{ id: 'https://a.test/1' }, { id: 'https://a.test/2' }], store, Date.now() - 1)
    expect(counts).toEqual({ stored: 0, existing: 0, skipped: 2, truncated: true })
    expect(store.storeById).not.toHaveBeenCalled()
  })

  it('asks for held replies in chunks', async () => {
    const { store } = memoryStore()
    const refs = Array.from({ length: 120 }, (_, i) => ({ id: `https://a.test/r/${i}` }))
    await storeReplies(refs, store, later())
    expect(vi.mocked(store.existing).mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20])
  })
})
