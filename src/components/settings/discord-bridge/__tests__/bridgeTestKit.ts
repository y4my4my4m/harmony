/**
 * Shared fixtures for the Discord bridge component tests: a real vue-i18n instance on
 * en.json that records missing keys, an in-memory PostgREST for the tables the UI reads,
 * and an RPC router.
 */
import { vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { supabase } from '@/supabase'
import en from '@/locales/en.json'
import { createFakePostgrest } from '../../../../../tests/helpers/fakePostgrest'
import type { BridgePairRow, DiscordBridgeRow } from '@/utils/discordBridgeSetup'

export const missingKeys: string[] = []

export function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: { en },
    missing: (_locale: string, key: string) => {
      missingKeys.push(key)
    },
    missingWarn: false,
    fallbackWarn: false,
  })
}

export const NOW = Date.parse('2026-10-07T12:00:00Z')
export const SEEN = new Date(NOW - 10_000).toISOString()
export const STALE = new Date(NOW - 3 * 60 * 60 * 1000).toISOString()

export const APP_ID = '111111111111111111'
export const GUILD_ID = '900'

export const HEALTHY_STATUS = {
  version: '2.0.0',
  discord: {
    connected: true,
    application_id: APP_ID,
    bot_user: { id: '222', name: 'Town Bridge', avatar: null },
    intents: { message_content: true, members: true, presence: false },
  },
  harmony: { connected: true },
  problems: [] as { code: string; params?: Record<string, string> }[],
}

export const SNAPSHOT = {
  guilds: [
    {
      id: GUILD_ID,
      name: 'Town Square',
      icon: null,
      channels: [
        { id: '10', name: 'Text', type: 4, parent_id: null, position: 0, can_view: true, can_send: true, can_manage_webhooks: true },
        { id: '11', name: 'general', type: 0, parent_id: '10', position: 1, can_view: true, can_send: true, can_manage_webhooks: true },
        { id: '12', name: 'secret', type: 0, parent_id: '10', position: 2, can_view: false, can_send: false, can_manage_webhooks: false },
        { id: '13', name: 'announcements', type: 5, parent_id: null, position: 0, can_view: true, can_send: true, can_manage_webhooks: false },
        { id: '14', name: 'memes', type: 0, parent_id: '10', position: 3, can_view: true, can_send: true, can_manage_webhooks: true },
      ],
    },
  ],
}

export const SERVER_ID = 's1'

export const CHANNEL_ROWS = [
  { id: 'h-general', server_id: SERVER_ID, name: 'general', type: 0, category: null, order: 0 },
  { id: 'h-memes', server_id: SERVER_ID, name: 'memes', type: 0, category: 'cat-1', order: 1 },
  { id: 'h-voice', server_id: SERVER_ID, name: 'Lounge', type: 1, category: null, order: 2 },
  { id: 'h-news', server_id: SERVER_ID, name: 'news', type: 0, category: 'cat-1', order: 0 },
]
export const CATEGORY_ROWS = [{ id: 'cat-1', server_id: SERVER_ID, name: 'Community', order: 0 }]

export const HARMONY_CHANNELS = [
  { id: 'h-general', name: 'general', categoryName: null },
  { id: 'h-news', name: 'news', categoryName: 'Community' },
  { id: 'h-memes', name: 'memes', categoryName: 'Community' },
]

export function makeBridge(overrides: Partial<DiscordBridgeRow> = {}): DiscordBridgeRow {
  return {
    id: 'b1',
    server_id: SERVER_ID,
    bot_id: 'bot-1',
    mode: 'self',
    discord_guild_id: null,
    discord_guild_name: null,
    discord_application_id: null,
    discord_bot_name: null,
    settings: { sync_member_list: true, sync_presence: false, sync_reactions: true, sync_edits: true, sync_deletes: true },
    snapshot: null,
    status: null,
    bridge_version: null,
    last_seen_at: null,
    ...overrides,
  }
}

export function healthyBridge(overrides: Partial<DiscordBridgeRow> = {}): DiscordBridgeRow {
  return makeBridge({
    discord_application_id: APP_ID,
    discord_bot_name: 'Town Bridge',
    status: HEALTHY_STATUS,
    snapshot: SNAPSHOT,
    bridge_version: '2.0.0',
    last_seen_at: SEEN,
    ...overrides,
  })
}

export function makePair(overrides: Partial<BridgePairRow> = {}): BridgePairRow {
  return {
    id: 'p1',
    bridge_id: 'b1',
    harmony_channel_id: 'h-general',
    discord_channel_id: '11',
    discord_channel_name: 'general',
    direction: 'both',
    ...overrides,
  }
}

export interface Backend {
  tables: Record<string, any[]>
  rpc: ReturnType<typeof vi.fn>
}

type RpcHandler = (name: string, args: Record<string, unknown>) => unknown

/** Routes supabase.from to in-memory tables and supabase.rpc to `handler` (result → data; thrown → error). */
export function installBackend(tables: Record<string, any[]> = {}, handler: RpcHandler = () => null): Backend {
  const fake = createFakePostgrest(tables)
  vi.mocked(supabase.from).mockReset()
  vi.mocked(supabase.rpc).mockReset()
  vi.mocked(supabase.from).mockImplementation(((table: string) => fake.from(table)) as never)
  const rpc = vi.mocked(supabase.rpc)
  rpc.mockImplementation((async (name: string, args: Record<string, unknown>) => {
    try {
      return { data: await handler(name, args ?? {}), error: null }
    } catch (error) {
      const e = error as { message?: string; code?: string }
      return { data: null, error: { message: e.message ?? String(error), code: e.code } }
    }
  }) as never)
  return { tables: fake.tables, rpc: rpc as unknown as ReturnType<typeof vi.fn> }
}

export function rpcCalls(name: string): Record<string, unknown>[] {
  return vi
    .mocked(supabase.rpc)
    .mock.calls.filter(([n]) => n === name)
    .map(([, args]) => args as Record<string, unknown>)
}

export const iconStub = { name: 'Icon', props: ['name', 'size'], template: '<span class="icon-stub" />' }
export const spinnerStub = { name: 'LoadingSpinner', template: '<span class="spinner-stub" />' }
