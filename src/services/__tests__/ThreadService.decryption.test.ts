import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import type { Message } from '@/types'

const PROFILE_ID = '11111111-1111-1111-1111-111111111111'
const CHANNEL_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const THREAD_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const PARENT_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentProfileId: vi.fn().mockResolvedValue('11111111-1111-1111-1111-111111111111'),
  },
}))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/services/core/messageLimits', () => ({
  messageLimits: vi.fn(async () => ({ maxLength: 2000, maxMedia: 20 })),
}))
vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: vi.fn() }))
vi.mock('@/services/core/channelMessageEncryption', async (original) => ({
  ...(await original<typeof import('@/services/core/channelMessageEncryption')>()),
  channelRequiresEncryption: vi.fn(async () => true),
  encryptChannelContent: vi.fn(async () => ({
    content: [{ type: 'text', text: 'CIPHERTEXT' }],
    encryption_metadata: { algorithm: 'megolm_v3', session_id: 's', message_index: 0 },
    media_paths: [],
  })),
}))

import { processMessageDecryption } from '@/utils/messageDecryption'
import { threadService } from '@/services/ThreadService'

const decrypt = vi.mocked(processMessageDecryption)
const opened = (row: Message): Message =>
  row.encrypted
    ? { ...row, content: [{ type: 'text', text: `plain ${row.id}` }], encrypted: false, decrypted: true }
    : row

const ciphertextRow = (id: string, created_at: string) => ({
  id,
  thread_id: THREAD_ID,
  channel_id: CHANNEL_ID,
  user_id: PROFILE_ID,
  created_at,
  content: [{ type: 'text', text: 'CIPHERTEXT' }],
  encrypted: true,
  encryption_metadata: { algorithm: 'megolm_v3', session_id: 's', message_index: 0 },
})

/** A thenable PostgREST builder: every filter returns itself, awaiting yields `result`. */
function builder(result: unknown, selects: string[] = []) {
  const chain: any = {
    select: (columns: string) => {
      selects.push(columns)
      return chain
    },
    then: (resolve: any) => resolve(result),
  }
  for (const method of ['eq', 'order', 'limit', 'lt', 'gt', 'maybeSingle']) chain[method] = () => chain
  chain.single = () => chain
  return chain
}

describe('ThreadService decryption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    threadService.clearThreadCache(THREAD_ID)
    decrypt.mockImplementation(async (rows) => rows.map(opened))
  })

  it('returns and caches thread history decrypted, oldest first', async () => {
    ;(supabase.from as any).mockImplementation(() =>
      builder({
        data: [ciphertextRow('newer', '2026-11-17T10:01:00Z'), ciphertextRow('older', '2026-11-17T10:00:00Z')],
        error: null,
      }),
    )

    const result = await threadService.getThreadMessages(THREAD_ID, { force: true })

    expect(result.messages.map((m) => m.content)).toEqual([
      [{ type: 'text', text: 'plain older' }],
      [{ type: 'text', text: 'plain newer' }],
    ])
    expect(result.messages.every((m) => m.decrypted)).toBe(true)
    const cached = threadService.getCachedMessages(THREAD_ID)
    expect(cached?.messages.map((m) => m.decrypted)).toEqual([true, true])
  })

  it('decrypts older pages', async () => {
    ;(supabase.from as any).mockImplementation(() =>
      builder({ data: [ciphertextRow('oldest', '2026-11-17T09:00:00Z')], error: null }),
    )
    const result = await threadService.getThreadMessages(THREAD_ID, { before: '2026-11-17T10:00:00Z' })
    expect(result.messages[0]).toMatchObject({ id: 'oldest', decrypted: true })
  })

  it('keeps ciphertext when the decryption fails as a whole', async () => {
    decrypt.mockRejectedValueOnce(new Error('encryption stack failed to load'))
    ;(supabase.from as any).mockImplementation(() =>
      builder({ data: [ciphertextRow('reply', '2026-11-17T10:00:00Z')], error: null }),
    )
    const result = await threadService.getThreadMessages(THREAD_ID, { force: true })
    expect(result.messages[0]).toMatchObject({ id: 'reply', encrypted: true })
    expect(result.messages[0].decrypted).toBeFalsy()
  })

  it('reads the parent message with its encryption fields and decrypts it', async () => {
    const selects: Record<string, string[]> = {}
    ;(supabase.from as any).mockImplementation((table: string) => {
      selects[table] ??= []
      if (table === 'threads') {
        return builder(
          { data: { id: THREAD_ID, channel_id: CHANNEL_ID, parent_message_id: PARENT_ID }, error: null },
          selects[table],
        )
      }
      if (table === 'channels') return builder({ data: { name: 'general', server_id: 's' }, error: null })
      if (table === 'messages') {
        return builder({ data: ciphertextRow(PARENT_ID, '2026-11-17T09:00:00Z'), error: null }, selects[table])
      }
      return builder({ data: null, error: null })
    })

    const thread = await threadService.getThread(THREAD_ID, true)

    expect(selects.messages[0]).toMatch(/\bencrypted\b/)
    expect(selects.messages[0]).toMatch(/\bencryption_metadata\b/)
    expect(selects.messages[0]).toMatch(/\bchannel_id\b/)
    expect(thread?.parent_message).toMatchObject({
      id: PARENT_ID,
      decrypted: true,
      content: [{ type: 'text', text: `plain ${PARENT_ID}` }],
    })
  })

  it('returns the sender their own encrypted reply as the parts they wrote', async () => {
    vi.spyOn(threadService, 'getThread').mockResolvedValueOnce({
      id: THREAD_ID,
      channel_id: CHANNEL_ID,
      server_id: 's',
    } as any)
    ;(supabase.from as any).mockImplementation((table: string) => {
      if (table !== 'messages') throw new Error(`Unhandled table in test mock: ${table}`)
      return {
        insert: (row: any) => builder({ data: [{ id: 'sent', created_at: '2026-11-17T10:00:00Z', ...row }], error: null }),
      }
    })

    const parts = [{ type: 'text', text: 'my reply' }] as any
    const sent = await threadService.sendThreadMessage(THREAD_ID, parts)

    expect(sent).toMatchObject({ id: 'sent', encrypted: true, decrypted: true, content: parts })
    expect(sent?.encryption_metadata).toMatchObject({ session_id: 's' })
    expect(decrypt).not.toHaveBeenCalled()
  })
})
