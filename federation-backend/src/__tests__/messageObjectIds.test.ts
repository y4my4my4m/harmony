import { describe, it, expect, vi } from 'vitest'

// Message ids across instances: a host names a message by the id it arrived under, and a copy
// finds one of its own messages by the id its host gave it.

const cfg = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'host.test', PUBLIC_SUPABASE_URL: 'https://db.host.test', SUPABASE_URL: 'http://kong:8000' }))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))

const { channelMessageActivity, messageObjectId } = await import('../activitypub/channelMessageActivity.js')
const { resolveMessageInChannel } = await import('../activitypub/channelWriteAuthz.js')

const SERVER = { id: '00000000-0000-4000-8000-000000000001', name: 'S' }
const CHANNEL = '00000000-0000-4000-8000-000000000002'
const author = { username: 'ann', federated_id: 'https://member.test/users/ann' }

describe('messageObjectId', () => {
  it('is the id a message arrived under, else this instance\'s URL', () => {
    expect(messageObjectId('m1', 'https://member.test/messages/x1')).toBe('https://member.test/messages/x1')
    expect(messageObjectId('m1', undefined)).toBe('https://host.test/messages/m1')
    expect(messageObjectId('m1', '')).toBe('https://host.test/messages/m1')
    expect(messageObjectId('m1', 'javascript:alert(1)')).toBe('https://host.test/messages/m1')
  })
})

describe('channelMessageActivity ids', () => {
  it('names a received message and its reply parent by the ids they arrived under', () => {
    const received = channelMessageActivity({
      id: 'row-1', author, content: [{ type: 'text', text: 'hi' }], created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z',
      metadata: { ap_id: 'https://member.test/messages/x1', federated: true },
      reply_to: 'row-0', reply_to_ap_id: 'https://member.test/messages/x0',
    }, SERVER, CHANNEL, 'general', 'Create', 'member.test')
    expect(received.object.id).toBe('https://member.test/messages/x1')
    expect(received.object.inReplyTo).toBe('https://member.test/messages/x0')
  })

  it('names a message written here by this instance\'s URL', () => {
    const own = channelMessageActivity({
      id: 'row-2', author, content: [{ type: 'text', text: 'hi' }], created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z',
      metadata: {}, reply_to: 'row-1',
    }, SERVER, CHANNEL, 'general', 'Create', 'member.test')
    expect(own.object.id).toBe('https://host.test/messages/row-2')
    expect(own.object.inReplyTo).toBe('https://host.test/messages/row-1')
  })
})

describe('resolveMessageInChannel', () => {
  // A minimal PostgREST stand-in: eq filters on columns and on metadata->>key.
  const rows = [
    { id: '10000000-0000-4000-8000-000000000001', channel_id: CHANNEL, metadata: { host_ap_id: 'https://older.test/messages/20000000-0000-4000-8000-000000000001' } },
    { id: '10000000-0000-4000-8000-000000000002', channel_id: 'elsewhere', metadata: { host_ap_id: 'https://older.test/messages/20000000-0000-4000-8000-000000000002' } },
  ]
  const supabase: any = {
    from: () => {
      const filters: Array<[string, string]> = []
      const q: any = {
        select: () => q,
        eq: (col: string, val: string) => { filters.push([col, val]); return q },
        maybeSingle: async () => {
          const hit = rows.find((r: any) => filters.every(([col, val]) => (col.startsWith('metadata->>')
            ? r.metadata?.[col.slice('metadata->>'.length)] === val
            : r[col] === val)))
          return { data: hit ? { id: hit.id } : null, error: null }
        },
      }
      return q
    },
  }

  it('finds one of this instance\'s messages by the id its host gave it, in that channel only', async () => {
    expect(await resolveMessageInChannel(supabase, 'https://older.test/messages/20000000-0000-4000-8000-000000000001', CHANNEL))
      .toBe('10000000-0000-4000-8000-000000000001')
    expect(await resolveMessageInChannel(supabase, 'https://older.test/messages/20000000-0000-4000-8000-000000000002', CHANNEL))
      .toBeNull()
  })
})
