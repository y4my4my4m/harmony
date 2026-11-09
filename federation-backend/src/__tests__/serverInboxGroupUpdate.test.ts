import { describe, it, expect, vi, beforeEach } from 'vitest'

// An Update{Group} sent to a local server's inbox passes that server's moderator check,
// but names a remote-server copy by the UUID in object.id. Only the copy's own Group may
// change the copy (ServerInboxHandler.ts processUpdateActivity, Group branch).
// Mocks follow inboundChannelWrites.test.ts.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    REQUIRE_VALID_SIGNATURES: true,
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
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
  enrichMessageLinkPreviews: vi.fn().mockResolvedValue(false),
  enrichPostLinkPreviews: vi.fn().mockResolvedValue(false),
}))
vi.mock('../utils/mentionResolver.js', () => ({
  resolveMentionUserIds: vi.fn(async (content: any) => content),
}))
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { enqueue: vi.fn(), sendToInbox: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let updates: Array<{ table: string; patch: Row; ids: string[] }> = []

// Table-backed fake Supabase: eq filters, select/maybeSingle/single, update.
function fakeSupabase() {
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let patch: Row | null = null
      const run = () => {
        const matched = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
        if (patch) {
          matched.forEach((row) => Object.assign(row, patch))
          updates.push({ table, patch, ids: matched.map((r) => r.id) })
        }
        return matched
      }
      const builder: any = {
        select() { return builder },
        update(p: Row) { patch = p; return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        single() {
          const rows = run()
          return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } })
        },
        then(resolve: any) { return Promise.resolve({ data: run(), error: null }).then(resolve) },
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const { processServerInboxActivity } = await import('../activitypub/ServerInboxHandler.js')

const COOKING = '00000000-0000-4000-8000-0000000000a1' // local server hosted here
const GAMERS = '00000000-0000-4000-8000-0000000000b2'  // this instance's copy of a server hosted on alpha.test
const MALLORY = 'https://evil.test/users/mallory'      // MANAGE_CHANNELS on COOKING only
const MEMBER = 'https://evil.test/users/plain'         // plain member of COOKING

const MANAGE_CHANNELS = 1n << 2n // PERM_MANAGE_CHANNELS = 2n in ServerInboxHandler.ts

const gamers = () => tables.servers.find((s) => s.id === GAMERS)!
const cooking = () => tables.servers.find((s) => s.id === COOKING)!

// The activity Mallory sends, signed with her own key, to /servers/<COOKING>/inbox.
// Only the trailing /servers/<uuid> of object.id names the copy, so any host works.
const attack = (actor: string, objectId = `https://evil.test/servers/${GAMERS}`) => ({
  '@context': 'https://www.w3.org/ns/activitystreams',
  id: `https://evil.test/activities/${Math.random()}`,
  type: 'Update',
  actor,
  object: {
    type: 'Group',
    id: objectId,
    name: 'Gamers (official support)',
    summary: 'Verify your account: https://evil.test/login',
    icon: { url: 'https://evil.test/pixel.png' },
    'harmony:public': true,
  },
})

beforeEach(() => {
  updates = []
  tables = {
    profiles: [
      { id: 'alice', federated_id: 'https://harmony.test/users/alice', is_local: true },
      { id: 'mallory', federated_id: MALLORY, is_local: false, is_suspended: false },
      { id: 'plain', federated_id: MEMBER, is_local: false, is_suspended: false },
    ],
    servers: [
      { id: COOKING, name: 'Cooking', is_local_server: true, federation_enabled: true, owner: 'alice', ap_id: null },
      {
        id: GAMERS, name: 'Gamers', description: 'The real one', icon: 'https://alpha.test/icon.png',
        public: false, is_local_server: false, federation_enabled: true, owner: null,
        ap_id: `https://alpha.test/servers/${GAMERS}`, host_domain: 'alpha.test',
      },
    ],
    user_servers: [
      { server_id: COOKING, user_id: 'mallory', status: 'accepted' },
      { server_id: COOKING, user_id: 'plain', status: 'accepted' },
      // Mallory is not a member of GAMERS and holds no role there.
    ],
    user_roles: [
      { user_id: 'mallory', server_id: COOKING, server_roles: { is_admin: false, permissions: String(MANAGE_CHANNELS) } },
    ],
  }
})

describe('Update{Group} on a local server inbox', () => {
  it.each([
    ['an attacker-hosted id', `https://evil.test/servers/${GAMERS}`],
    ['the copy\'s real Group id', `https://alpha.test/servers/${GAMERS}`],
  ])('does not let a moderator of COOKING rewrite the GAMERS copy (%s)', async (_label, objectId) => {
    const before = { ...gamers() }
    await processServerInboxActivity(COOKING, attack(MALLORY, objectId), { verifiedSigner: MALLORY })

    expect(gamers()).toEqual(before) // name, description, icon and public unchanged
    expect(cooking().name).toBe('Cooking')
    expect(updates).toEqual([])
  })

  it('refuses a plain member of COOKING at the moderator check', async () => {
    await processServerInboxActivity(COOKING, attack(MEMBER), { verifiedSigner: MEMBER })

    expect(gamers().name).toBe('Gamers')
    expect(updates).toEqual([])
  })
})
