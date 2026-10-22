/**
 * The conversation list loaded without get_user_conversations carries what the last-message
 * preview reads: a system row's metadata names a missed call, not the call notice's text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const db = vi.hoisted(() => {
  const tables: Record<string, Array<Array<Record<string, unknown>>>> = {}
  // PostgREST projection: a top-level column absent from select() is absent from the row.
  const project = (rows: Array<Record<string, unknown>>, select: string) => {
    if (/[()]/.test(select)) return rows
    const columns = select.split(',').map(c => c.trim()).filter(Boolean)
    return rows.map(row => Object.fromEntries(columns.filter(c => c in row).map(c => [c, row[c]])))
  }
  const from = vi.fn((table: string) => {
    let select = '*'
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') {
          const rows = tables[table]?.shift() ?? []
          return (res: any, rej: any) => Promise.resolve({ data: project(rows, select), error: null }).then(res, rej)
        }
        return (...args: any[]) => {
          if (prop === 'select') select = String(args[0])
          return chain
        }
      },
    })
    return chain
  })
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'function get_user_conversations does not exist' } }))
  return { tables, from, rpc }
})

vi.mock('@/supabase', () => ({ supabase: { from: db.from, rpc: db.rpc, removeChannel: vi.fn() } }))
vi.mock('@/services', () => ({ services: { messages: {} } }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: {} }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({}), seedNoReactions: vi.fn() }))
vi.mock('@/stores/usePins', () => ({ usePinsStore: () => ({ applyRealtimeRow: vi.fn(), applyRealtimeDelete: vi.fn() }) }))
vi.mock('@/services/userDataService', () => ({
  userDataService: { getCurrentUser: () => ({ id: 'me' }), addEventListener: vi.fn(), removeEventListener: vi.fn() },
}))
vi.mock('@/utils/unifiedContentProcessing', () => ({ extractMentionsFromMessageParts: vi.fn(() => []) }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: vi.fn(async (m: any[]) => m) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/RealtimeConnectionManager', () => ({
  realtimeConnectionManager: { hasSubscription: vi.fn(() => false), unsubscribe: vi.fn(), subscribeToTable: vi.fn(() => vi.fn()) },
}))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { connect: vi.fn(), on: vi.fn(() => () => {}) } }))
vi.mock('@/services/readState', () => ({ fetchUnreadCounts: vi.fn(async () => []), markConversationRead: vi.fn(async () => {}) }))
vi.mock('@/composables/useFloatingVideo', () => ({ releaseFloatingVideo: vi.fn() }))

import { useDMStore } from '@/stores/useDM'
import { systemEventPreviewKey } from '@/utils/systemEvents'

const CONV = 'conv-1'

beforeEach(() => {
  setActivePinia(createPinia())
  for (const key of Object.keys(db.tables)) delete db.tables[key]
})

describe('conversation list without get_user_conversations', () => {
  it('previews a missed call from the system row metadata', async () => {
    db.tables.conversation_participants = [
      [{
        conversation_id: CONV,
        hidden_at: null,
        conversations: { id: CONV, created_at: '2026-10-01T00:00:00Z', type: 'group', name: 'G', updated_at: '2026-10-01T00:00:00Z', metadata: {} },
      }],
      [{ conversation_id: CONV, user_id: 'them' }],
    ]
    db.tables.messages = [[{
      id: 'sys-1',
      conversation_id: CONV,
      user_id: null,
      is_system: true,
      content: [{ type: 'text', text: 'started a call' }],
      metadata: { type: 'call_ended', call_type: 'voice', actor_id: 'them', participants: ['them'] },
      encrypted: false,
      created_at: '2026-10-02T00:00:00Z',
    }]]

    const store = useDMStore()
    await store.fetchUserConversationsMetadata('me', 'lazy')

    const preview = store.conversations[0].last_message as any
    expect(preview.is_system).toBe(true)
    expect(systemEventPreviewKey(preview.metadata)).toBe('dm.missedCall')
  })
})
