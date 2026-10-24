import { supabase } from '@/supabase'

/**
 * Outgoing webhooks of a bot or a server (migration 20261028600001): events POSTed to a URL,
 * signed per Standard Webhooks. The RPCs refuse anyone but the bot's owner or the server's
 * webhook managers; the secret is returned on create and rotate only.
 */

/** outgoing_webhook_event_types(), grouped as the panel shows them. */
export const OUTGOING_WEBHOOK_EVENT_GROUPS = [
  { key: 'messages', events: ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE'] },
  { key: 'reactions', events: ['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE'] },
  { key: 'members', events: ['SERVER_MEMBER_ADD', 'SERVER_MEMBER_REMOVE'] },
  { key: 'moderation', events: ['SERVER_MEMBER_KICK', 'SERVER_BAN_ADD', 'SERVER_BAN_REMOVE'] },
] as const

export type OutgoingWebhookEvent = (typeof OUTGOING_WEBHOOK_EVENT_GROUPS)[number]['events'][number]

export const MAX_OUTGOING_WEBHOOKS = 5

export interface OutgoingWebhook {
  id: string
  bot_id: string | null
  server_id: string | null
  name: string
  url: string
  events: OutgoingWebhookEvent[]
  secret_hint: string | null
  is_active: boolean
  disabled_reason: 'owner' | 'failing' | null
  failing_since: string | null
  last_success_at: string | null
  last_failure_at: string | null
  last_status: number | null
  last_error: string | null
  created_at: string
}

export interface OutgoingWebhookWithSecret extends OutgoingWebhook {
  secret: string
}

export interface OutgoingWebhookDelivery {
  id: string
  event: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  last_status: number | null
  last_error: string | null
  created_at: string
  delivered_at: string | null
  next_attempt_at: string | null
}

export type OutgoingWebhookOwner = { botId: string; serverId?: undefined } | { serverId: string; botId?: undefined }

function ownerArgs(owner: OutgoingWebhookOwner) {
  return { p_bot_id: owner.botId ?? null, p_server_id: owner.serverId ?? null }
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return data as T
}

export const listOutgoingWebhooks = (owner: OutgoingWebhookOwner) =>
  call<OutgoingWebhook[]>('list_outgoing_webhooks', ownerArgs(owner))

export const createOutgoingWebhook = (owner: OutgoingWebhookOwner, fields: { name: string; url: string; events: string[] }) =>
  call<OutgoingWebhookWithSecret>('create_outgoing_webhook', {
    ...ownerArgs(owner), p_name: fields.name, p_url: fields.url, p_events: fields.events,
  })

export const updateOutgoingWebhook = (
  id: string,
  patch: { name?: string; url?: string; events?: string[]; active?: boolean },
) => call<OutgoingWebhook>('update_outgoing_webhook', {
  p_webhook_id: id,
  p_name: patch.name ?? null,
  p_url: patch.url ?? null,
  p_events: patch.events ?? null,
  p_active: patch.active ?? null,
})

export const rotateOutgoingWebhookSecret = (id: string) =>
  call<OutgoingWebhookWithSecret>('rotate_outgoing_webhook_secret', { p_webhook_id: id })

export const deleteOutgoingWebhook = (id: string) => call<void>('delete_outgoing_webhook', { p_webhook_id: id })

export const listOutgoingWebhookDeliveries = (id: string, limit = 25) =>
  call<OutgoingWebhookDelivery[]>('list_outgoing_webhook_deliveries', { p_webhook_id: id, p_limit: limit })

export const testOutgoingWebhook = (id: string) => call<string>('test_outgoing_webhook', { p_webhook_id: id })

const ERROR_KEYS: Array<[string, string]> = [
  ['OUTGOING_WEBHOOK_FORBIDDEN', 'outgoingWebhooks.errors.forbidden'],
  ['OUTGOING_WEBHOOK_NOT_FOUND', 'outgoingWebhooks.errors.notFound'],
  ['OUTGOING_WEBHOOK_INVALID_NAME', 'outgoingWebhooks.errors.invalidName'],
  ['OUTGOING_WEBHOOK_INVALID_URL', 'outgoingWebhooks.errors.invalidUrl'],
  ['OUTGOING_WEBHOOK_INVALID_EVENTS', 'outgoingWebhooks.errors.invalidEvents'],
  ['OUTGOING_WEBHOOK_LIMIT', 'outgoingWebhooks.errors.limit'],
  ['OUTGOING_WEBHOOK_UNAVAILABLE', 'outgoingWebhooks.errors.unavailable'],
]

/** The i18n key for an RPC error, by the stable code its message begins with. */
export function outgoingWebhookErrorKey(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '')
  return ERROR_KEYS.find(([code]) => message.startsWith(code))?.[1] ?? 'outgoingWebhooks.errors.saveFailed'
}
