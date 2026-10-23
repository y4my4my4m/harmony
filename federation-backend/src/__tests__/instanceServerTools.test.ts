import { describe, it, expect, vi, beforeEach } from 'vitest'

// An instance's tools for servers hosted elsewhere (migration 20261027300001).
//
// federate-instance-leave: a local member removed by this instance's staff, or by a block, sends
// the Group the member's own Leave, signed as the member, and the leave is marked delivered. A
// member back in the server since sends nothing.
//
// Joins: a blocked copy refuses every local account, a keep-out the kept-out one; a lookup that
// fails refuses nothing here (the user_servers guard still does).

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const sent = vi.hoisted(() => [] as Array<{ inbox: string; activity: any; signer: unknown }>)
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: {
    sendToInbox: vi.fn(async (inbox: string, activity: any, signer: unknown) => { sent.push({ inbox, activity, signer }) }),
  },
}))

const rows: Record<string, any[] | undefined> = {}

function query(table: string) {
  const filters: Array<[string, unknown]> = []
  let update: any = null
  const missing = () => rows[table] === undefined
  const all = () => (rows[table] ?? []).filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v))
  const q: any = {
    select: () => q,
    update: (values: any) => { update = values; return q },
    eq: (c: string, v: unknown) => (filters.push([c, v]), q),
    is: (c: string, v: unknown) => (filters.push([c, v]), q),
    maybeSingle: async () => missing()
      ? { data: null, error: { code: 'PGRST205', message: `relation ${table} not found` } }
      : { data: all()[0] ?? null, error: null },
    then: (resolve: any) => {
      if (update) {
        all().forEach((r) => Object.assign(r, update))
        return resolve({ data: null, error: null })
      }
      return resolve({ data: all(), error: null })
    },
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: (t: string) => query(t) }),
  getSupabaseClientWithAuth: () => ({}),
}))

const { handleInstanceLeaveJob } = await import('../queue/handlers/instanceLeaveHandler.js')
const { joinRefusalHere, isGroupBlockedHere } = await import('../activitypub/instanceServerBlocks.js')
const { instanceRemovedNoticeText } = await import('../services/pushPolicy.js')
const { getSupabaseClient } = await import('../config/supabase.js')

const SERVER = 'f1830000-0000-0000-0000-0000000000c1'
const GROUP = `https://remote.test/servers/${SERVER}`
const LEFT_AT = '2026-10-23T12:00:00.000Z'

beforeEach(() => {
  sent.length = 0
  for (const key of Object.keys(rows)) delete rows[key]
  rows.instance_server_leaves = [
    { id: 'l1', server_id: SERVER, profile_id: 'bob', reason: 'removed', created_at: LEFT_AT, delivered_at: null },
  ]
  rows.servers = [
    { id: SERVER, ap_id: GROUP, federation_inbox_url: `${GROUP}/inbox`, is_local_server: false },
  ]
  rows.profiles = [
    { id: 'bob', username: 'bob', federated_id: 'https://harmony.test/users/bob', is_local: true },
  ]
  rows.user_servers = []
})

describe('handleInstanceLeaveJob', () => {
  it('sends the member\'s Leave to the Group\'s inbox, signed as the member, and marks it delivered', async () => {
    await handleInstanceLeaveJob({ type: 'delete', leave_id: 'l1' })

    expect(sent).toHaveLength(1)
    expect(sent[0].inbox).toBe(`${GROUP}/inbox`)
    expect(sent[0].signer).toBe('bob')
    expect(sent[0].activity).toMatchObject({ type: 'Leave', actor: 'https://harmony.test/users/bob', object: GROUP })
    expect(rows.instance_server_leaves![0].delivered_at).toEqual(expect.any(String))
  })

  it('sends nothing again once delivered', async () => {
    rows.instance_server_leaves![0].delivered_at = '2026-10-23T12:00:01.000Z'
    await handleInstanceLeaveJob({ type: 'delete', leave_id: 'l1' })
    expect(sent).toHaveLength(0)
  })

  it('sends nothing for a member back in the server since, and marks it delivered', async () => {
    rows.user_servers = [{ server_id: SERVER, user_id: 'bob', created_at: '2026-10-24T09:00:00.000Z' }]
    await handleInstanceLeaveJob({ type: 'delete', leave_id: 'l1' })
    expect(sent).toHaveLength(0)
    expect(rows.instance_server_leaves![0].delivered_at).toEqual(expect.any(String))
  })

  it('marks a leave with no Group inbox to tell delivered', async () => {
    rows.servers![0].federation_inbox_url = null
    await handleInstanceLeaveJob({ type: 'delete', leave_id: 'l1' })
    expect(sent).toHaveLength(0)
    expect(rows.instance_server_leaves![0].delivered_at).toEqual(expect.any(String))
  })

  it('ignores a job without a leave id', async () => {
    await handleInstanceLeaveJob({ type: 'delete' })
    expect(sent).toHaveLength(0)
  })
})

describe('joins of a server hosted elsewhere', () => {
  const supabase = () => getSupabaseClient() as any

  it('refuses every local account when the server is blocked here', async () => {
    rows.instance_server_blocks = [{ server_id: SERVER, blocked: true }]
    rows.instance_server_keepouts = []
    expect(await joinRefusalHere(supabase(), SERVER, 'bob')).toEqual({
      code: 'server_blocked_here',
      error: 'This server is blocked on harmony.test',
    })
  })

  it('refuses a kept-out account and no one else', async () => {
    rows.instance_server_blocks = [{ server_id: SERVER, blocked: false, media_hidden: true }]
    rows.instance_server_keepouts = [{ server_id: SERVER, profile_id: 'bob' }]
    expect((await joinRefusalHere(supabase(), SERVER, 'bob'))?.code).toBe('kept_out_here')
    expect(await joinRefusalHere(supabase(), SERVER, 'alice')).toBeNull()
  })

  it('refuses nothing when the tables cannot be read', async () => {
    expect(await joinRefusalHere(supabase(), SERVER, 'bob')).toBeNull()
  })

  it('finds a blocked copy by its Group', async () => {
    rows.instance_server_blocks = [{ server_id: SERVER, blocked: true }]
    expect(await isGroupBlockedHere(supabase(), GROUP)).toBe(true)
    expect(await isGroupBlockedHere(supabase(), 'https://remote.test/servers/other')).toBe(false)
  })
})

describe('instanceRemovedNoticeText', () => {
  const server = { id: SERVER, name: 'Elsewhere', ap_id: GROUP }

  it('names the instance\'s staff and the reason given', () => {
    expect(instanceRemovedNoticeText({ server, action: 'remove', reason: 'spam' }, 'harmony.test')).toEqual({
      title: 'You were removed from Elsewhere by harmony.test staff.',
      body: 'Reason given: spam',
    })
    expect(instanceRemovedNoticeText({ server, action: 'remove', reason: null }, 'harmony.test').body)
      .toBe('No reason was given.')
  })

  it('says a block left the server on this instance only', () => {
    expect(instanceRemovedNoticeText({ server, action: 'block' }, 'harmony.test')).toEqual({
      title: 'harmony.test staff blocked Elsewhere on harmony.test; you left it.',
      body: 'Nothing changed for Elsewhere on other instances.',
    })
  })
})
