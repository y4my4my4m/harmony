import { describe, it, expect, vi, beforeEach } from 'vitest'

// A federated DM carries its attachments as Documents whose URLs name the recipient's instance.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', SUPABASE_SERVICE_ROLE_KEY: 'k' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../activitypub/ActivityProcessor.js', () => ({ ActivityProcessor: {} }))
vi.mock('../services/LinkPreviewService.js', () => ({ linkPreviewService: {} }))
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { enqueue: vi.fn(async () => undefined) },
}))

const CONVERSATION = '77777777-0000-4000-8000-000000000007'
const PATH = `d/${CONVERSATION}/aaaaaaaa-0000-4000-8000-000000000001/notes.pdf`

const SINGLE: Record<string, any> = {
  profiles: { id: 'alice', username: 'alice', is_local: true, domain: 'harmony.test' },
  conversations: { type: 'group' },
  messages: null,
}
const LIST: Record<string, any[]> = {
  conversation_participants: [{ user_id: 'bob' }, { user_id: 'carol' }],
  profiles: [
    { id: 'bob', username: 'bob', domain: 'one.example', is_local: false, federated_id: 'https://one.example/users/bob', inbox_url: 'https://one.example/users/bob/inbox' },
    { id: 'carol', username: 'carol', domain: 'Two.Example', is_local: false, federated_id: 'https://two.example/users/carol', inbox_url: 'https://two.example/users/carol/inbox' },
  ],
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      const q: any = {
        select: () => q, eq: () => q, neq: () => q, is: () => q, in: () => q, not: () => q,
        order: () => q, limit: () => q, update: () => q,
        single: () => Promise.resolve({ data: SINGLE[table] ?? null, error: null }),
        then: (resolve: any) => resolve({ data: LIST[table] ?? null, error: null }),
      }
      return q
    },
  }),
}))

const { handleNewDM } = await import('../listeners/DatabaseListener.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const enqueue = vi.mocked(DeliveryQueue.enqueue)

beforeEach(() => {
  enqueue.mockClear()
})

describe('federated DM attachments', () => {
  it('delivers each recipient a Document URL bound to its instance', async () => {
    await handleNewDM({
      id: '99999999-0000-4000-8000-000000000009',
      user_id: 'alice',
      conversation_id: CONVERSATION,
      created_at: '2026-01-01T00:00:00Z',
      content: [
        { type: 'text', text: 'see attached' },
        { type: 'file', fileType: 'file', fileName: 'notes.pdf', url: 'https://db.harmony.test/storage/v1/object/sign/x?token=t', path: PATH },
      ],
    })

    expect(enqueue.mock.calls.map(c => c[1])).toEqual([
      'https://one.example/users/bob/inbox',
      'https://two.example/users/carol/inbox',
    ])
    const audiences = enqueue.mock.calls.map(c => {
      const attachments = (c[0] as any).object.attachment
      expect(attachments).toHaveLength(1)
      expect(attachments[0]).toMatchObject({ type: 'Document', mediaType: 'application/pdf', name: 'notes.pdf' })
      const url = new URL(attachments[0].url)
      expect(url.origin + url.pathname).toBe(`https://harmony.test/api/federation/media/${PATH}`)
      return url.searchParams.get('to')
    })
    expect(audiences).toEqual(['one.example', 'two.example'])
  })
})
