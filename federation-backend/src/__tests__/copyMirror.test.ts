import { describe, it, expect, vi } from 'vitest'

// A server hosted elsewhere as its member instances show it: roles, pins, instance staff and
// channel positions on the wire (activitypub/copyMirror.ts).

vi.mock('../config/index.js', () => {
  const cfg = { INSTANCE_DOMAIN: 'host.test', SUPABASE_URL: 'http://kong:8000', PUBLIC_SUPABASE_URL: 'https://db.host.test' }
  return { default: cfg, config: cfg }
})
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: vi.fn() }))
vi.mock('../utils/urlUtils.js', () => ({
  getFullAvatarUrl: vi.fn((url: string | null) => url || null),
  getFullBannerUrl: vi.fn((url: string | null) => url || null),
  getFullEmojiUrl: vi.fn((url: string | null) => url || null),
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const mirror = await import('../activitypub/copyMirror.js')
const { profileToActor } = await import('../activitypub/converters/toActivityPub.js')
const { actorToProfile } = await import('../activitypub/converters/fromActivityPub.js')

const GROUP = 'https://host.test/servers/11111111-1111-4111-8111-111111111111'
const ROLE_A = '22222222-2222-4222-8222-222222222222'
const ROLE_B = '33333333-3333-4333-8333-333333333333'
const CHANNEL = `${GROUP}/channels/44444444-4444-4444-8444-444444444444`

describe('roles', () => {
  const rows = [
    { id: 'e0e0e0e0-0000-4000-8000-000000000000', name: 'everyone', color: '#99AAB5', position: 0, is_default: true, hoist: false },
    { id: ROLE_A, name: 'Tester', color: '#E91E63', position: 5, hoist: true, mentionable: false, unicode_emoji: '🧪' },
    { id: ROLE_B, name: 'Admin', color: 'red', position: 999, hoist: false, mentionable: null },
  ]

  it('lists every role but the default one, highest first, with no permission bits', () => {
    const roles = mirror.rolesToAp(GROUP, rows)
    expect(roles.map((r) => r.name)).toEqual(['Admin', 'Tester'])
    expect(roles[1]).toEqual({
      type: 'harmony:Role', id: `${GROUP}/roles/${ROLE_A}`, name: 'Tester', color: '#e91e63', position: 5,
      hoist: true, mentionable: false, unicodeEmoji: '🧪',
    })
    expect(roles[0].color).toBeNull()
    expect(roles[0].mentionable).toBe(true)
    expect(roles.some((r) => 'permissions' in r)).toBe(false)
  })

  it('reads back what it writes', () => {
    const parsed = mirror.parseGroupRoles(mirror.rolesToAp(GROUP, rows), GROUP)!
    expect(parsed.find((r) => r.uuid === ROLE_A)).toEqual({
      uuid: ROLE_A, apId: `${GROUP}/roles/${ROLE_A}`, name: 'Tester', color: '#e91e63', position: 5,
      hoist: true, mentionable: false, unicodeEmoji: '🧪',
    })
  })

  it('is null for a Group that lists none, so an older host leaves the copy as it is', () => {
    expect(mirror.parseGroupRoles(undefined, GROUP)).toBeNull()
    expect(mirror.parseGroupRoles({}, GROUP)).toBeNull()
    expect(mirror.parseGroupRoles([], GROUP)).toEqual([])
  })

  it('keeps only roles under the Group, named, once', () => {
    const parsed = mirror.parseGroupRoles([
      { id: `https://elsewhere.test/servers/x/roles/${ROLE_A}`, name: 'Forged' },
      { id: `${GROUP}/roles/not-a-uuid`, name: 'Bad' },
      { id: `${GROUP}/roles/${ROLE_A}`, name: '  ' },
      { id: `${GROUP}/roles/${ROLE_A}`, name: 'First', position: 7.9, color: '#12345' },
      { id: `${GROUP}/roles/${ROLE_A}`, name: 'Again' },
      { id: `${GROUP}/roles/${ROLE_B}`, name: 'x'.repeat(300), position: 1e12, unicodeEmoji: 5 },
      null,
      'text',
    ], GROUP)!
    expect(parsed.map((r) => r.name)).toEqual(['First', 'x'.repeat(100)])
    expect(parsed[0]).toMatchObject({ position: 7, color: null, hoist: false, mentionable: true })
    expect(parsed[1]).toMatchObject({ position: 1_000_000, unicodeEmoji: null })
  })

  it('reads at most 250 roles', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `${GROUP}/roles/${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, name: `r${i}`,
    }))
    expect(mirror.parseGroupRoles(many, GROUP)).toHaveLength(250)
  })
})

describe('member roles', () => {
  it('names a member and all their roles', () => {
    expect(mirror.memberRolesObject(GROUP, 'u1', 'https://member.test/users/ann', [ROLE_A])).toEqual({
      type: 'harmony:MemberRoles', id: `${GROUP}/members/u1/roles`, member: 'https://member.test/users/ann',
      roles: [`${GROUP}/roles/${ROLE_A}`],
    })
  })

  it('keeps the Group\'s roles of an entry and drops entries without a member', () => {
    expect(mirror.parseMemberRoles([
      { member: 'https://member.test/users/ann', roles: [`${GROUP}/roles/${ROLE_A}`, `https://elsewhere.test/roles/${ROLE_B}`, `${GROUP}/roles/${ROLE_A}`] },
      { member: 'javascript:alert(1)', roles: [] },
      { member: 'https://member.test/users/bo', roles: 'all' },
      { roles: [] },
    ], GROUP)).toEqual([{ member: 'https://member.test/users/ann', roles: [`${GROUP}/roles/${ROLE_A}`] }])
    expect(mirror.parseMemberRoles(undefined, GROUP)).toBeNull()
  })

  it('reads an Update object only of type harmony:MemberRoles', () => {
    const object = mirror.memberRolesObject(GROUP, 'u1', 'https://member.test/users/ann', [])
    expect(mirror.parseMemberRolesObject(object, GROUP)).toEqual({ member: 'https://member.test/users/ann', roles: [] })
    expect(mirror.parseMemberRolesObject({ ...object, type: 'Group' }, GROUP)).toBeNull()
    expect(mirror.parseMemberRolesObject(null, GROUP)).toBeNull()
  })
})

describe('pins', () => {
  it('advertises the count and the newest pin of a channel', () => {
    expect(mirror.pinsAdvert(CHANNEL, ['2026-10-01T00:00:00Z', '2026-10-03T12:00:00+02:00', '2026-10-02T00:00:00Z'])).toEqual({
      type: 'OrderedCollection', id: `${CHANNEL}/pins`, totalItems: 3, updated: '2026-10-03T10:00:00.000Z',
    })
    expect(mirror.pinsAdvert(CHANNEL, [])).toMatchObject({ totalItems: 0, updated: null })
  })

  it('reads an advert only for its own channel', () => {
    const advert = mirror.pinsAdvert(CHANNEL, ['2026-10-01T00:00:00Z'])
    expect(mirror.parsePinsAdvert(advert, CHANNEL)).toEqual({ id: `${CHANNEL}/pins`, totalItems: 1, updated: '2026-10-01T00:00:00.000Z' })
    expect(mirror.parsePinsAdvert(advert, `${GROUP}/channels/55555555-5555-4555-8555-555555555555`)).toBeNull()
    expect(mirror.parsePinsAdvert({ ...advert, totalItems: -1 }, CHANNEL)).toBeNull()
    expect(mirror.parsePinsAdvert({ ...advert, updated: 'soon' }, CHANNEL)?.updated).toBeNull()
    expect(mirror.parsePinsAdvert(undefined, CHANNEL)).toBeNull()
  })

  it('takes a pins target only under the Group\'s own channels', () => {
    expect(mirror.isPinsTarget(`${CHANNEL}/pins`)).toBe(true)
    expect(mirror.isPinsTarget(`${GROUP}/featured`)).toBe(false)
    expect(mirror.pinsTargetChannel(`${CHANNEL}/pins`, GROUP)).toBe(CHANNEL)
    expect(mirror.pinsTargetChannel(`${CHANNEL}/pins`, 'https://elsewhere.test/servers/x')).toBeNull()
    expect(mirror.pinsTargetChannel(`${GROUP}/channels/x/pins`, GROUP)).toBeNull()
    expect(mirror.pinsTargetChannel(CHANNEL, GROUP)).toBeNull()
  })

  it('reads a pin time as an ISO timestamp', () => {
    expect(mirror.parsePinnedAt('2026-10-27T10:00:00+09:00')).toBe('2026-10-27T01:00:00.000Z')
    expect(mirror.parsePinnedAt('yesterday')).toBeNull()
    expect(mirror.parsePinnedAt(5)).toBeNull()
  })
})

describe('instance staff', () => {
  it('is the role a local account holds here, admin first', () => {
    expect(mirror.instanceRoleOf({ is_admin: true, is_moderator: true })).toBe('admin')
    expect(mirror.instanceRoleOf({ is_moderator: true })).toBe('moderator')
    expect(mirror.instanceRoleOf({ is_admin: false })).toBeNull()
  })

  it('is on a staff account\'s actor and absent from a member\'s', () => {
    expect(profileToActor({ username: 'ann', is_admin: true })['harmony:instanceRole']).toBe('admin')
    expect(profileToActor({ username: 'bo', is_moderator: true })['harmony:instanceRole']).toBe('moderator')
    expect('harmony:instanceRole' in profileToActor({ username: 'cy' })).toBe(false)
  })

  it('is read from an actor as admin, moderator or nothing', () => {
    const actor = { id: 'https://member.test/users/ann', inbox: 'https://member.test/users/ann/inbox', preferredUsername: 'ann' }
    expect(actorToProfile({ ...actor, 'harmony:instanceRole': 'admin' }).instance_role).toBe('admin')
    expect(actorToProfile({ ...actor, 'harmony:instanceRole': 'moderator' }).instance_role).toBe('moderator')
    expect(actorToProfile({ ...actor, 'harmony:instanceRole': 'owner' }).instance_role).toBeNull()
    expect(actorToProfile(actor).instance_role).toBeNull()
  })
})

describe('channel positions', () => {
  it('sends order with position, 0 included', () => {
    expect(mirror.channelPosition(0)).toEqual({ position: 0, order: 0 })
    expect(mirror.channelPosition(3)).toEqual({ position: 3, order: 3 })
    expect(mirror.channelPosition(null)).toEqual({ position: 0, order: 0 })
  })

  it('reads position 0, falls back to order, and is undefined with neither', () => {
    expect(mirror.parseChannelPosition({ position: 0 })).toBe(0)
    expect(mirror.parseChannelPosition({ position: 0, order: 5 })).toBe(0)
    expect(mirror.parseChannelPosition({ order: 2 })).toBe(2)
    expect(mirror.parseChannelPosition({ position: '1' })).toBeUndefined()
    expect(mirror.parseChannelPosition({})).toBeUndefined()
  })

  it('is what a receiver before 1.9.1 reads from a 1.9.1 Update', () => {
    // ActivityProcessor.processHarmonyChannelUpdate before 1.9.1: order = position || order.
    const object = mirror.channelPosition(0) as { position: number; order: number }
    expect(object.position || object.order).toBe(0)
  })
})
