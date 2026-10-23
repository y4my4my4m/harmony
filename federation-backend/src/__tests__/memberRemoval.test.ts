import { describe, it, expect, vi, beforeEach } from 'vitest'

// federate-member-removal: a member from another instance removed from a local server (federation
// turned off, a kick, a ban, the account suspended here) is sent the Group's Remove at their inbox,
// signed with the Group's key, and the removal is marked delivered. A member back in the server
// since is sent nothing. A removal by this instance's staff says so (harmony:staff).

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

const rows: Record<string, any[]> = {}

function query(table: string) {
  const filters: Array<[string, string, unknown]> = []
  let update: any = null
  const all = () => (rows[table] ?? []).filter((r) => filters.every(([op, c, v]) => (op === 'eq' ? r[c] === v : (r[c] ?? null) === v)))
  const q: any = {
    select: () => q,
    update: (values: any) => { update = values; return q },
    eq: (c: string, v: unknown) => (filters.push(['eq', c, v]), q),
    is: (c: string, v: unknown) => (filters.push(['is', c, v]), q),
    maybeSingle: async () => ({ data: all()[0] ?? null, error: null }),
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
}))

const { handleMemberRemovalJob } = await import('../queue/handlers/memberRemovalHandler.js')
const { memberRemoveActivity, membershipOutlivesRemove, removalReason, removedByStaff } = await import('../activitypub/memberRemoval.js')

const SERVER = 'f1680000-0000-0000-0000-0000000000a1'
const GROUP = `https://harmony.test/servers/${SERVER}`
const MEMBER = 'https://remote.test/users/rm'
const REMOVED_AT = '2026-10-21T12:00:00.000Z'

beforeEach(() => {
  sent.length = 0
  rows.federation_member_removals = [
    { id: 'r1', server_id: SERVER, profile_id: 'rm-id', reason: 'federation_closed', summary: null, created_at: REMOVED_AT, delivered_at: null },
  ]
  rows.profiles = [
    { id: 'rm-id', federated_id: MEMBER, inbox_url: `${MEMBER}/inbox`, shared_inbox_url: 'https://remote.test/inbox', is_local: false },
  ]
  rows.user_servers = []
})

describe('memberRemoveActivity', () => {
  it('is the Group\'s Remove of the member from its members, fixed per removal', () => {
    expect(memberRemoveActivity(rows.federation_member_removals[0], MEMBER)).toEqual({
      '@context': ['https://www.w3.org/ns/activitystreams', { harmony: 'https://mony.lol/ns#' }],
      id: `${GROUP}/activities/removal-r1`,
      type: 'Remove',
      actor: GROUP,
      object: MEMBER,
      target: `${GROUP}/members`,
      to: [MEMBER],
      published: REMOVED_AT,
      summary: 'This server stopped taking members from other instances',
      'harmony:reason': 'federation_closed',
    })
  })

  it('carries the moderator\'s reason for a kick or ban, and none when none was given', () => {
    const ban = memberRemoveActivity({ ...rows.federation_member_removals[0], reason: 'ban', summary: 'spam' }, MEMBER)
    expect(ban).toMatchObject({ summary: 'spam', 'harmony:reason': 'ban' })
    const kick = memberRemoveActivity({ ...rows.federation_member_removals[0], reason: 'kick', summary: null }, MEMBER)
    expect(kick).not.toHaveProperty('summary')
  })

  it('reads only the reasons it sends', () => {
    expect(removalReason({ 'harmony:reason': 'kick' })).toBe('kick')
    expect(removalReason({ 'harmony:reason': 'suspended' })).toBe('suspended')
    expect(removalReason({ 'harmony:reason': 'mute' })).toBeNull()
    expect(removalReason({})).toBeNull()
  })

  it('marks a removal by instance staff, and only that one', () => {
    const staff = memberRemoveActivity({ ...rows.federation_member_removals[0], reason: 'suspended', staff: true }, MEMBER)
    expect(staff).toMatchObject({ 'harmony:reason': 'suspended', 'harmony:staff': true })
    expect(staff).not.toHaveProperty('summary')
    expect(removedByStaff(staff)).toBe(true)

    const moderator = memberRemoveActivity({ ...rows.federation_member_removals[0], reason: 'kick', staff: false }, MEMBER)
    expect(moderator).not.toHaveProperty('harmony:staff')
    expect(removedByStaff(moderator)).toBe(false)
    expect(removedByStaff({ 'harmony:staff': 'true' })).toBe(false)
  })

  it('counts a membership as newer only when both times are known', () => {
    expect(membershipOutlivesRemove('2026-10-21T13:00:00Z', REMOVED_AT)).toBe(true)
    expect(membershipOutlivesRemove('2026-10-21T11:00:00Z', REMOVED_AT)).toBe(false)
    expect(membershipOutlivesRemove('2026-10-21T13:00:00Z', undefined)).toBe(false)
    expect(membershipOutlivesRemove('not a date', REMOVED_AT)).toBe(false)
  })
})

describe('handleMemberRemovalJob', () => {
  it('sends the Remove to the member\'s inbox, signed as the Group, and marks it delivered', async () => {
    await handleMemberRemovalJob({ type: 'delete', removal_id: 'r1' })

    expect(sent).toHaveLength(1)
    expect(sent[0].inbox).toBe(`${MEMBER}/inbox`)
    expect(sent[0].signer).toEqual({ serverId: SERVER })
    expect(sent[0].activity).toMatchObject({ type: 'Remove', actor: GROUP, object: MEMBER, target: `${GROUP}/members` })
    expect(rows.federation_member_removals[0].delivered_at).toEqual(expect.any(String))
  })

  it('sends a staff removal as staff', async () => {
    Object.assign(rows.federation_member_removals[0], { reason: 'suspended', staff: true })
    await handleMemberRemovalJob({ type: 'delete', removal_id: 'r1' })
    expect(sent[0].activity).toMatchObject({ 'harmony:reason': 'suspended', 'harmony:staff': true })
  })

  it('sends nothing again once delivered', async () => {
    rows.federation_member_removals[0].delivered_at = '2026-10-21T12:00:01.000Z'
    await handleMemberRemovalJob({ type: 'delete', removal_id: 'r1' })
    expect(sent).toHaveLength(0)
  })

  it('sends nothing to a member who rejoined since, and marks it delivered', async () => {
    rows.user_servers = [{ server_id: SERVER, user_id: 'rm-id', created_at: '2026-10-22T09:00:00.000Z' }]
    await handleMemberRemovalJob({ type: 'delete', removal_id: 'r1' })
    expect(sent).toHaveLength(0)
    expect(rows.federation_member_removals[0].delivered_at).toEqual(expect.any(String))
  })

  it('falls back to the shared inbox, and marks a removal with no inbox to tell delivered', async () => {
    rows.profiles[0].inbox_url = null
    await handleMemberRemovalJob({ type: 'delete', removal_id: 'r1' })
    expect(sent[0].inbox).toBe('https://remote.test/inbox')

    sent.length = 0
    rows.federation_member_removals[0].delivered_at = null
    rows.profiles[0].shared_inbox_url = null
    await handleMemberRemovalJob({ type: 'delete', removal_id: 'r1' })
    expect(sent).toHaveLength(0)
    expect(rows.federation_member_removals[0].delivered_at).toEqual(expect.any(String))
  })

  it('ignores a job without a removal id', async () => {
    await handleMemberRemovalJob({ type: 'delete' })
    expect(sent).toHaveLength(0)
  })
})
