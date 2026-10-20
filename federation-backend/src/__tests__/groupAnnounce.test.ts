import { describe, it, expect, vi, beforeEach } from 'vitest'

// FEP-1b12 Announce of an activity by a Group that is not a Harmony server (Lemmy, PieFed,
// Mbin): the member's Create, Update or Delete is processed as its origin serves it, only
// for a Group a local account follows; a top-level post becomes the Group's boost, once,
// whether it came wrapped or as Lemmy's plain Announce{Page}.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => fn,
  AppError: class extends Error {},
}))
const blocked = vi.hoisted(() => new Set<string>())
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (host: string) => blocked.has(host) },
}))

type Op = { table: string; op: string; values?: any; filters: Array<[string, string, unknown]> }
const ops: Op[] = []
const rows: Record<string, any[]> = {}

function query(table: string) {
  const op: Op = { table, op: 'select', filters: [] }
  const result = () => {
    if (op.op !== 'select') {
      ops.push(op)
      return { data: null, error: null }
    }
    const data = (rows[table] ?? []).filter((r) => op.filters.every(([kind, c, v]) => kind !== 'eq' || r[c] === v))
    return { data, error: null }
  }
  const q: any = {
    select: () => q,
    insert: (values: any) => { op.op = 'insert'; op.values = values; return q },
    update: (values: any) => { op.op = 'update'; op.values = values; return q },
    eq: (c: string, v: unknown) => (op.filters.push(['eq', c, v]), q),
    is: () => q,
    in: () => q,
    limit: () => q,
    maybeSingle: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: null } },
    single: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: null } },
    then: (resolve: any) => resolve(result()),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: (t: string) => query(t), rpc: async () => ({ data: null, error: null }) }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const { unwrapGroupAnnounce, boostedTopLevelPost } = await import('../activitypub/groupAnnounce.js')
const P = ActivityProcessor as any

const AS = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = `${AS}#Public`
const GROUP = 'https://lemmy.test/c/tech'
const ANN = 'https://lemmy.world.test/u/ann'
const PAGE = 'https://lemmy.world.test/post/7'
const COMMENT = 'https://lemmy.world.test/comment/9'

const page = { id: PAGE, type: 'Page', attributedTo: ANN, name: 'Rust 2.0', content: '<p>hi</p>', to: [GROUP, PUBLIC], cc: [], audience: GROUP }
const comment = { id: COMMENT, type: 'Note', attributedTo: ANN, content: '<p>yes</p>', inReplyTo: PAGE, to: [PUBLIC], cc: [GROUP], audience: GROUP }
const create = (object: any) => ({ id: `https://lemmy.world.test/activities/create/${object.id.split('/').pop()}`, type: 'Create', actor: ANN, to: [PUBLIC], object })
const announce = (inner: any, n = 1) => ({ '@context': AS, id: `https://lemmy.test/activities/announce/${n}`, type: 'Announce', actor: GROUP, to: [PUBLIC], cc: [`${GROUP}/followers`], object: inner })

/** An origin serving `docs`; anything else answers `missing`. */
function origin(docs: Record<string, any>, missing = 404) {
  return {
    fetchDoc: vi.fn(async (url: string, onStatus?: (s: number) => void) => {
      const doc = docs[url]
      onStatus?.(doc ? 200 : missing)
      return doc ? { doc, finalUrl: url } : null
    }),
    storedPostVisibility: vi.fn(async (apId: string) => (apId === PAGE ? 'public' : null)),
    isBlockedHost: (host: string) => blocked.has(host),
  }
}

beforeEach(() => {
  ops.length = 0
  blocked.clear()
  vi.restoreAllMocks()
  rows.profiles = [{ id: 'group-id', federated_id: GROUP, is_local: false, is_suspended: false, deleted_at: null }]
  rows.follows = [{ id: 'f1', following_id: 'group-id', status: 'accepted', 'follower.is_local': true }]
  rows.posts = []
  rows.post_interactions = []
  rows.servers = []
})

describe('unwrapGroupAnnounce', () => {
  it('takes a member\'s Create with the object its origin serves', async () => {
    const served = { ...page, content: '<p>served</p>' }
    const out = await unwrapGroupAnnounce(announce(create({ ...page, content: '<p>forged</p>' })), GROUP, origin({ [PAGE]: served }))
    expect(out).toMatchObject({ activity: { type: 'Create', actor: ANN, object: { id: PAGE, content: '<p>served</p>' } } })
  })

  it('refuses a Create whose served object is another account\'s', async () => {
    const out = await unwrapGroupAnnounce(announce(create(page)), GROUP, origin({ [PAGE]: { ...page, attributedTo: 'https://lemmy.world.test/u/bob' } }))
    expect(out).toMatchObject({ refused: expect.stringContaining('another actor') })
  })

  it('refuses a Create its origin does not serve', async () => {
    const out = await unwrapGroupAnnounce(announce(create(page)), GROUP, origin({}))
    expect('refused' in out).toBe(true)
  })

  it('ignores votes, Undo and moderation', async () => {
    for (const type of ['Like', 'Dislike', 'Undo', 'Remove', 'Block', 'Lock']) {
      const out = await unwrapGroupAnnounce(announce({ id: `${ANN}#${type}`, type, actor: ANN, object: PAGE }), GROUP, origin({}))
      expect(out).toEqual({ ignored: `${type} is not taken from a Group` })
    }
  })

  it('refuses a member on a blocked instance before fetching', async () => {
    blocked.add('lemmy.world.test')
    const deps = origin({ [PAGE]: page })
    const out = await unwrapGroupAnnounce(announce(create(page)), GROUP, deps)
    expect(out).toMatchObject({ refused: expect.stringContaining('blocked') })
    expect(deps.fetchDoc).not.toHaveBeenCalled()
  })

  it('takes the Group\'s own activity as sent', async () => {
    const update = { id: `${GROUP}#update`, type: 'Update', actor: GROUP, object: { id: GROUP, type: 'Group', name: 'Tech' } }
    const deps = origin({})
    expect(await unwrapGroupAnnounce(announce(update), GROUP, deps)).toEqual({ activity: update })
    expect(deps.fetchDoc).not.toHaveBeenCalled()
  })

  it('takes a member\'s Delete once the origin answers 404, refuses it while the post is served', async () => {
    const del = { id: `${ANN}#delete-7`, type: 'Delete', actor: ANN, object: PAGE }
    expect(await unwrapGroupAnnounce(announce(del), GROUP, origin({}))).toEqual({
      activity: { id: del.id, type: 'Delete', actor: ANN, object: PAGE },
    })
    expect('refused' in await unwrapGroupAnnounce(announce(del), GROUP, origin({ [PAGE]: page }))).toBe(true)
  })

  it('refuses an Announce embedding no activity', async () => {
    expect(await unwrapGroupAnnounce({ ...announce(null), object: PAGE }, GROUP, origin({}))).toEqual({ refused: 'the Announce embeds no activity' })
  })

  it('boosts a top-level post only', () => {
    expect(boostedTopLevelPost(create(page))).toBe(PAGE)
    expect(boostedTopLevelPost(create(comment))).toBeNull()
    expect(boostedTopLevelPost({ type: 'Update', object: page })).toBeNull()
  })
})

describe('processIncomingActivity: Announce of an activity by a Group', () => {
  function spies(docs: Record<string, any>) {
    vi.spyOn(P, 'ensureRemoteUser').mockResolvedValue({ id: 'group-id' })
    vi.spyOn(P, 'fetchApDocument').mockImplementation(async (url: any, onStatus: any) => {
      const doc = docs[url]
      onStatus?.(doc ? 200 : 404)
      return doc ? { doc, finalUrl: url } : null
    })
    return {
      create: vi.spyOn(P, 'processCreate').mockResolvedValue(undefined),
      update: vi.spyOn(P, 'processUpdate').mockResolvedValue(undefined),
      boost: vi.spyOn(P, 'processAnnounce').mockResolvedValue(undefined),
      relay: vi.spyOn(P, 'processGroupRelay').mockResolvedValue(undefined),
    }
  }

  it('stores a followed community\'s post as its author\'s and boosts it as the Group', async () => {
    const s = spies({ [PAGE]: page })
    const wrapped = announce(create(page))
    await ActivityProcessor.processIncomingActivity(wrapped)

    expect(s.relay).not.toHaveBeenCalled()
    expect(s.create).toHaveBeenCalledTimes(1)
    expect(s.create.mock.calls[0][0]).toMatchObject({ type: 'Create', actor: ANN, object: { id: PAGE, type: 'Page' } })
    expect(s.boost).toHaveBeenCalledWith({ id: wrapped.id, type: 'Announce', actor: GROUP, object: PAGE, published: undefined })
  })

  it('stores a comment without boosting it', async () => {
    const s = spies({ [COMMENT]: comment })
    await ActivityProcessor.processIncomingActivity(announce(create(comment)))
    expect(s.create).toHaveBeenCalledTimes(1)
    expect(s.boost).not.toHaveBeenCalled()
  })

  it('applies an edit as an Update of the served object', async () => {
    const s = spies({ [PAGE]: { ...page, name: 'Rust 2.1' } })
    await ActivityProcessor.processIncomingActivity(announce({ ...create(page), id: 'https://lemmy.world.test/activities/update/1', type: 'Update' }))
    expect(s.update.mock.calls[0][0]).toMatchObject({ type: 'Update', object: { name: 'Rust 2.1' } })
    expect(s.create).not.toHaveBeenCalled()
  })

  it('takes nothing from a Group no local account follows', async () => {
    rows.follows = []
    const s = spies({ [PAGE]: page })
    await ActivityProcessor.processIncomingActivity(announce(create(page)))
    expect(s.create).not.toHaveBeenCalled()
    expect(s.boost).not.toHaveBeenCalled()
  })

  it('drops a relayed channel message and a relayed direct post', async () => {
    const channelNote = { ...comment, 'harmony:serverId': 'f0210000-0000-0000-0000-000000000009' }
    const direct = { ...comment, to: ['https://harmony.test/users/alice'], cc: [] }
    for (const object of [channelNote, direct]) {
      const s = spies({ [COMMENT]: object })
      await ActivityProcessor.processIncomingActivity(announce(create(object)))
      expect(s.create).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    }
  })

  it('drops a relayed vote', async () => {
    const s = spies({})
    await ActivityProcessor.processIncomingActivity(announce({ id: `${ANN}#like`, type: 'Like', actor: ANN, object: PAGE }))
    expect(s.create).not.toHaveBeenCalled()
    expect(s.boost).not.toHaveBeenCalled()
  })

  it('leaves a Harmony server\'s relay to the Group relay', async () => {
    const SERVER = 'f0210000-0000-0000-0000-000000000001'
    const groupUrl = `https://peer.test/servers/${SERVER}`
    rows.servers = [{ id: SERVER, ap_id: groupUrl, is_local_server: false }]
    const s = spies({})
    await ActivityProcessor.processIncomingActivity({ ...announce(create(page)), actor: groupUrl })
    expect(s.relay).toHaveBeenCalledTimes(1)
    expect(s.create).not.toHaveBeenCalled()
  })
})

describe('processAnnounce: one boost per account and post', () => {
  beforeEach(() => {
    vi.spyOn(P, 'ensureRemoteUser').mockResolvedValue({ id: 'group-id' })
    rows.posts = [{ id: 'page-id', ap_id: PAGE, visibility: 'public', is_deleted: false, author_id: 'ann-id', content: [], metadata: {} }]
    rows.profiles.push({ id: 'ann-id', username: 'ann', domain: 'lemmy.world.test', is_local: false })
  })

  it('records the first boost', async () => {
    await ActivityProcessor.processIncomingActivity(announce(page, 1))
    expect(ops.filter((o) => o.table === 'posts' && o.op === 'insert')).toHaveLength(1)
  })

  it('drops a second Announce of a post the Group already boosted', async () => {
    rows.post_interactions = [{ id: 'i1', user_id: 'group-id', post_id: 'page-id', interaction_type: 'reblog' }]
    await ActivityProcessor.processIncomingActivity(announce(page, 2))
    expect(ops.filter((o) => o.op === 'insert')).toEqual([])
  })
})
