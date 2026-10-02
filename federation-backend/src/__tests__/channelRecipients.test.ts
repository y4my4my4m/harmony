import { describe, it, expect, vi, beforeEach } from 'vitest'

// Channel content reaches only instances of remote members who can view the
// channel, as public.federation_channel_recipients reports them.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', SUPABASE_URL: 'https://db.harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { enqueue: vi.fn(async () => undefined) },
}))

const SERVER = '00000000-0000-4000-8000-0000000000a1'
const CHANNEL = '00000000-0000-4000-8000-0000000000c1'
const MESSAGE = '00000000-0000-4000-8000-0000000000e1'

let recipients: { data: any; error: any }
let messageContent: any[] = [{ type: 'text', text: 'hi' }]
const rpc = vi.fn(async (name: string, _args: any) =>
  name === 'federation_channel_recipients' ? recipients : { data: null, error: { message: `unexpected ${name}` } })
const messageUpdates: any[] = []

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc,
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => {
          if (table === 'messages') {
            return Promise.resolve({
              data: {
                id: MESSAGE,
                channel_id: CHANNEL,
                content: messageContent,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                federation_status: 'pending',
                metadata: {},
                author: { id: 'alice', username: 'alice', federated_id: 'https://harmony.test/users/alice', is_local: true },
                channel: { name: 'general' },
              },
              error: null,
            })
          }
          if (table === 'servers') {
            return Promise.resolve({ data: { id: SERVER, name: 'S', is_local_server: true, federation_enabled: true, owner: 'alice' }, error: null })
          }
          return Promise.resolve({ data: null, error: null })
        },
        update: (row: any) => { if (table === 'messages') messageUpdates.push(row); return q },
        then: (resolve: any) => resolve({ data: null, error: null }),
      }
      return q
    },
  }),
}))

const { getChannelRecipientGroups } = await import('../utils/federationUtils.js')
const {
  handleChannelMessageFederation,
  handleChannelMessageUpdate,
  handleChannelMessageDelete,
} = await import('../listeners/ChannelMessageHandler.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const enqueue = vi.mocked(DeliveryQueue.enqueue)

beforeEach(() => {
  rpc.mockClear()
  enqueue.mockClear()
  messageUpdates.length = 0
  messageContent = [{ type: 'text', text: 'hi' }]
  recipients = {
    data: [
      { instance: 'remote.test', member_ap_ids: ['https://remote.test/users/rm'], member_count: 1, shared_inbox: 'https://remote.test/inbox' },
      { instance: 'other.test', member_ap_ids: ['https://other.test/users/ro'], member_count: 1, shared_inbox: null },
      { instance: 'harmony.test', member_ap_ids: ['https://harmony.test/users/x'], member_count: 1, shared_inbox: null },
    ],
    error: null,
  }
})

describe('getChannelRecipientGroups', () => {
  it('asks for the channel and maps its groups, dropping this instance', async () => {
    const groups = await getChannelRecipientGroups(CHANNEL)
    expect(rpc).toHaveBeenCalledWith('federation_channel_recipients', { p_channel_id: CHANNEL })
    expect(groups).toEqual([
      { instance: 'remote.test', member_ap_ids: ['https://remote.test/users/rm'], member_count: 1, shared_inbox: 'https://remote.test/inbox' },
      { instance: 'other.test', member_ap_ids: ['https://other.test/users/ro'], member_count: 1, shared_inbox: 'https://other.test/inbox' },
    ])
  })

  it('yields no groups when the lookup fails', async () => {
    recipients = { data: null, error: { message: 'function does not exist' } }
    await expect(getChannelRecipientGroups(CHANNEL)).resolves.toEqual([])
  })
})

describe('channel message fan-out', () => {
  it('delivers a new message once per recipient instance, addressed to its viewers', async () => {
    await handleChannelMessageFederation({
      message_id: MESSAGE, channel_id: CHANNEL, server_id: SERVER, channel_name: 'general', author_id: 'alice',
    })

    expect(rpc.mock.calls.map(c => c[0])).toEqual(['federation_channel_recipients'])
    expect(rpc.mock.calls[0][1]).toEqual({ p_channel_id: CHANNEL })
    expect(enqueue.mock.calls.map(c => [c[1], (c[0] as any).to])).toEqual([
      ['https://remote.test/inbox', ['https://remote.test/users/rm']],
      ['https://other.test/inbox', ['https://other.test/users/ro']],
    ])
  })

  it('delivers nothing, and marks the message skipped, when no remote member can view the channel', async () => {
    recipients = { data: [], error: null }
    await handleChannelMessageFederation({
      message_id: MESSAGE, channel_id: CHANNEL, server_id: SERVER, channel_name: 'general', author_id: 'alice',
    })
    expect(enqueue).not.toHaveBeenCalled()
    expect(messageUpdates.map(u => u.federation_status)).toEqual(['skipped'])
  })

  it('delivers nothing when the recipient lookup fails', async () => {
    recipients = { data: null, error: { message: 'boom' } }
    await handleChannelMessageFederation({
      message_id: MESSAGE, channel_id: CHANNEL, server_id: SERVER, channel_name: 'general', author_id: 'alice',
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('scopes edits and deletions to the same recipients', async () => {
    await handleChannelMessageUpdate({ message_id: MESSAGE, channel_id: CHANNEL, server_id: SERVER })
    await handleChannelMessageDelete({ message_id: MESSAGE, channel_id: CHANNEL, server_id: SERVER })

    expect(rpc.mock.calls.every(c => c[0] === 'federation_channel_recipients' && (c[1] as any).p_channel_id === CHANNEL)).toBe(true)
    expect(enqueue.mock.calls.map(c => c[1])).toEqual([
      'https://remote.test/inbox', 'https://other.test/inbox',
      'https://remote.test/inbox', 'https://other.test/inbox',
    ])
  })
})

describe('channel attachments', () => {
  const PATH = `c/${CHANNEL}/aaaaaaaa-0000-4000-8000-000000000001/cat.png`

  it('gives each recipient instance its own attachment URL and never the path', async () => {
    messageContent = [
      { type: 'text', text: 'look' },
      { type: 'file', fileType: 'image', fileName: 'cat.png', url: 'https://db.harmony.test/storage/v1/object/sign/x?token=t', path: PATH },
    ]
    await handleChannelMessageFederation({
      message_id: MESSAGE, channel_id: CHANNEL, server_id: SERVER, channel_name: 'general', author_id: 'alice',
    })

    const delivered = enqueue.mock.calls.map(c => (c[0] as any).object)
    expect(delivered).toHaveLength(2)
    for (const [object, instance] of [[delivered[0], 'remote.test'], [delivered[1], 'other.test']] as const) {
      const file = object['harmony:rawContent'][1]
      expect(file).not.toHaveProperty('path')
      const url = new URL(file.url)
      expect(url.origin + url.pathname).toBe(`https://harmony.test/api/federation/media/${PATH}`)
      expect(url.searchParams.get('to')).toBe(instance)
      expect(object.attachment).toEqual([
        { type: 'Document', mediaType: 'image/png', url: file.url, name: 'cat.png' },
      ])
    }
    expect(delivered[0]['harmony:rawContent'][1].url).not.toBe(delivered[1]['harmony:rawContent'][1].url)
  })
})
