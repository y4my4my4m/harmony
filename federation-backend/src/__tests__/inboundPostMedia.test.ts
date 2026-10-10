import { describe, it, expect, vi, beforeEach } from 'vitest'

// Inbound remote posts: attachments of media-only Notes, posts.media_attachments on every
// path that stores or edits a remote post, and boosts of posts not stored yet. The
// database double runs no triggers.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn(async () => false),
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let nextId = 1

const read = (row: Row, col: string) => {
  const [base, key] = col.split('->>')
  return key ? row[base]?.[key] : row[base]
}

function fakeSupabase() {
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let op: 'select' | 'update' = 'select'
      let patch: Row = {}
      const run = () => {
        const matched = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
        if (op === 'update') matched.forEach((row) => Object.assign(row, patch))
        return matched
      }
      const builder: any = {
        select() { return builder },
        update(p: Row) { op = 'update'; patch = p; return builder },
        insert(row: Row) {
          const stored = { id: `row-${nextId++}`, is_deleted: false, metadata: {}, ...row }
          ;(tables[table] ??= []).push(stored)
          const result = { data: stored, error: null }
          return {
            select: () => ({ single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result) }),
            then: (resolve: any) => resolve(result),
          }
        },
        eq(col: string, val: any) { filters.push((row) => read(row, col) === val); return builder },
        is(col: string, val: any) { filters.push((row) => (read(row, col) ?? null) === val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(read(row, col))); return builder },
        or(expr: string) {
          const clauses = [...expr.matchAll(/([\w]+(?:->>[\w]+)?)\.eq\.(?:"((?:[^"\\]|\\.)*)"|([^,]*))/g)]
            .map((m) => ({ col: m[1], val: (m[2] ?? m[3]).replace(/\\(.)/g, '$1') }))
          filters.push((row) => clauses.some((c) => read(row, c.col) === c.val))
          return builder
        },
        limit() { return builder },
        order() { return builder },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        single() {
          const rows = run()
          return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } })
        },
        then(resolve: any) { return resolve({ data: run(), error: null }) },
      }
      return builder
    },
  }
}
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const { noteToContent, extractMediaAttachments } = await import('../activitypub/converters/fromActivityPub.js')
const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const P = ActivityProcessor as any

const FRESH = new Date().toISOString()
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const AUTHOR = 'https://mastodon.test/users/ana'
const BOOSTER = 'https://other.test/users/ben'

const IMAGE = {
  type: 'Document',
  mediaType: 'image/png',
  url: 'https://files.mastodon.test/a.png',
  name: 'a red square',
  width: 640,
  height: 480,
  blurhash: 'UBL_:rOpGG-oBUNG',
  focalPoint: [0.5, -0.25],
}

const STORED_IMAGE = {
  type: 'Document',
  mediaType: 'image/png',
  url: 'https://files.mastodon.test/a.png',
  description: 'a red square',
  width: 640,
  height: 480,
  blurhash: 'UBL_:rOpGG-oBUNG',
  focalPoint: [0.5, -0.25],
}

const note = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'Note', attributedTo: AUTHOR, to: [PUBLIC], content: '<p>hello</p>', ...extra,
})

/** fetchApDocument double serving each document at its own id. */
function serve(...docs: any[]) {
  return vi.spyOn(ActivityProcessor, 'fetchApDocument').mockImplementation(async (url: string) => {
    const doc = docs.find((d) => d.id === url)
    return doc ? { doc, finalUrl: url } : null
  })
}

const post = (apId: string) => tables.posts.find((p) => p.ap_id === apId)

beforeEach(() => {
  nextId = 1
  vi.restoreAllMocks()
  tables = {
    profiles: [
      { id: 'ana-id', username: 'ana', domain: 'mastodon.test', is_local: false, federated_id: AUTHOR, updated_at: FRESH },
      { id: 'ben-id', username: 'ben', domain: 'other.test', is_local: false, federated_id: BOOSTER, updated_at: FRESH },
    ],
    posts: [],
    post_interactions: [],
  }
})

describe('noteToContent', () => {
  it('keeps the attachments of a Note with empty content', () => {
    for (const content of ['', null, undefined]) {
      expect(noteToContent({ type: 'Note', content, attachment: [IMAGE] })).toEqual([
        expect.objectContaining({ type: 'file', url: IMAGE.url, fileType: 'image', altText: 'a red square' }),
      ])
    }
  })

  it('stores an empty text part for a Note with neither content nor attachments', () => {
    expect(noteToContent({ type: 'Note', content: '' })).toEqual([{ type: 'text', text: '' }])
  })

  it('reads one attachment object and Link urls; drops attachments without an http(s) url', () => {
    const parts = noteToContent({
      type: 'Note',
      content: '',
      attachment: [
        { type: 'Video', mediaType: 'video/mp4', url: [{ type: 'Link', href: 'https://files.test/v.mp4' }] },
        { type: 'Document', mediaType: 'image/png', url: 'javascript:alert(1)' },
        { type: 'Document', mediaType: 'image/png' },
      ],
    })
    expect(parts).toEqual([expect.objectContaining({ url: 'https://files.test/v.mp4', fileType: 'video' })])
    expect(noteToContent({ type: 'Note', content: '', attachment: IMAGE })).toHaveLength(1)
  })
})

describe('extractMediaAttachments', () => {
  it('stores the AP name as description, the alt text', () => {
    expect(extractMediaAttachments([IMAGE])).toEqual([STORED_IMAGE])
  })

  it('fills absent fields and skips attachments without an http(s) url', () => {
    expect(extractMediaAttachments([{ url: 'https://files.test/x' }, { type: 'Image' }, 'https://files.test/y'])).toEqual([{
      type: 'Document', mediaType: 'application/octet-stream', url: 'https://files.test/x',
      description: null, width: null, height: null, blurhash: null, focalPoint: null,
    }])
    expect(extractMediaAttachments(undefined)).toEqual([])
  })
})

describe('media_attachments of stored remote posts', () => {
  it('processCreate stores a sensitive media-only Note with its attachments', async () => {
    await P.processCreate({
      type: 'Create', id: `${AUTHOR}/statuses/1/activity`, actor: AUTHOR,
      object: note(`${AUTHOR}/statuses/1`, { content: '', sensitive: true, summary: 'cw', attachment: [IMAGE] }),
    }, { skipSpamGuard: true })

    const stored = post(`${AUTHOR}/statuses/1`)
    expect(stored?.media_attachments).toEqual([STORED_IMAGE])
    expect(stored?.is_sensitive).toBe(true)
    expect(stored?.content_warning).toBe('cw')
    expect(stored?.content).toEqual([expect.objectContaining({ type: 'file', url: IMAGE.url })])
  })

  it('processCreate stores a poll with its attachments', async () => {
    await P.processCreate({
      type: 'Create', id: `${AUTHOR}/statuses/2/activity`, actor: AUTHOR,
      object: note(`${AUTHOR}/statuses/2`, { type: 'Question', oneOf: [{ type: 'Note', name: 'yes' }], attachment: [IMAGE] }),
    }, { skipSpamGuard: true })
    expect(post(`${AUTHOR}/statuses/2`)?.media_attachments).toEqual([STORED_IMAGE])
  })

  it('a quote snapshot carries the quoted post\'s media and sensitivity', async () => {
    tables.posts.push({
      id: 'quoted', ap_id: `${AUTHOR}/statuses/3`, author_id: 'ana-id', visibility: 'public', is_deleted: false,
      content: [{ type: 'text', text: 'quoted' }], created_at: FRESH,
      media_attachments: [STORED_IMAGE], is_sensitive: true, content_warning: null,
    })
    await P.processCreate({
      type: 'Create', id: `${BOOSTER}/statuses/4/activity`, actor: BOOSTER,
      object: { ...note(`${BOOSTER}/statuses/4`), attributedTo: BOOSTER, quoteUrl: `${AUTHOR}/statuses/3` },
    }, { skipSpamGuard: true })
    expect(post(`${BOOSTER}/statuses/4`)?.reblog).toMatchObject({
      id: 'quoted', media_attachments: [STORED_IMAGE], is_sensitive: true,
    })
  })

  it('storeRemotePost stores the attachments and the sensitive flag', async () => {
    await P.storeRemotePost(note(`${AUTHOR}/statuses/5`, { sensitive: true, attachment: [IMAGE] }))
    const stored = post(`${AUTHOR}/statuses/5`)
    expect(stored?.media_attachments).toEqual([STORED_IMAGE])
    expect(stored?.is_sensitive).toBe(true)
  })

  it('an edit replaces the attachments with the edited Note\'s', async () => {
    tables.posts.push({
      id: 'edited', ap_id: `${AUTHOR}/statuses/6`, author_id: 'ana-id', profiles: { federated_id: AUTHOR },
      content: [], media_attachments: [STORED_IMAGE],
    })
    const other = { ...IMAGE, url: 'https://files.mastodon.test/b.png', name: 'b' }
    await P.processUpdate({ type: 'Update', actor: AUTHOR, object: note(`${AUTHOR}/statuses/6`, { attachment: [other] }) })
    expect(post(`${AUTHOR}/statuses/6`)?.media_attachments).toEqual([
      { ...STORED_IMAGE, url: 'https://files.mastodon.test/b.png', description: 'b' },
    ])
  })
})

describe('Announce of a post not stored yet', () => {
  it('stores a boosted Question through storeRemotePost, then the boost', async () => {
    const question = note(`${AUTHOR}/statuses/7`, {
      type: 'Question', content: '<p>pick one</p>', sensitive: true, attachment: [IMAGE],
      oneOf: [{ type: 'Note', name: 'a', replies: { totalItems: 2 } }, { type: 'Note', name: 'b' }],
      inReplyTo: null,
    })
    serve(question)
    const store = vi.spyOn(ActivityProcessor, 'storeRemotePost')

    await P.processAnnounce({ type: 'Announce', id: `${BOOSTER}/statuses/8/activity`, actor: BOOSTER, object: question.id })

    expect(store).toHaveBeenCalledWith(question)
    const original = post(question.id)
    expect(original).toMatchObject({
      ap_type: 'Question', url: question.id, is_sensitive: true, media_attachments: [STORED_IMAGE],
      metadata: expect.objectContaining({ is_poll: true, poll_options: [{ name: 'a', votes: 2 }, { name: 'b', votes: 0 }] }),
    })
    const boost = post(`${BOOSTER}/statuses/8/activity`)
    expect(boost).toMatchObject({ author_id: 'ben-id', ap_type: 'Announce', metadata: { reblog_of: original!.id } })
    expect(boost?.reblog).toMatchObject({
      id: original!.id, is_sensitive: true, media_attachments: [STORED_IMAGE],
      metadata: expect.objectContaining({ is_poll: true }),
    })
    expect(tables.post_interactions).toEqual([
      expect.objectContaining({ user_id: 'ben-id', post_id: original!.id, interaction_type: 'reblog' }),
    ])
  })

  it('stores a boosted Article reply with its url and parent', async () => {
    tables.posts.push({ id: 'parent', ap_id: `${AUTHOR}/statuses/9`, in_reply_to: null, conversation_root_id: null })
    const article = note(`${AUTHOR}/statuses/10`, {
      type: 'Article', url: 'https://mastodon.test/@ana/10', inReplyTo: `${AUTHOR}/statuses/9`,
    })
    serve(article)

    await P.processAnnounce({ type: 'Announce', id: `${BOOSTER}/statuses/11/activity`, actor: BOOSTER, object: article.id })

    expect(post(article.id)).toMatchObject({ url: 'https://mastodon.test/@ana/10', in_reply_to: 'parent' })
    expect(post(`${BOOSTER}/statuses/11/activity`)?.reblog?.id).toBe(post(article.id)!.id)
  })

  it('stores nothing for a followers-only post', async () => {
    const privateNote = note(`${AUTHOR}/statuses/12`, { to: [`${AUTHOR}/followers`] })
    serve(privateNote)
    const store = vi.spyOn(ActivityProcessor, 'storeRemotePost')

    await P.processAnnounce({ type: 'Announce', id: `${BOOSTER}/statuses/13/activity`, actor: BOOSTER, object: privateNote.id })

    expect(store).not.toHaveBeenCalled()
    expect(tables.posts).toEqual([])
  })
})
