import { supabase } from '@/supabase'
import { runtimeConfig } from '@/services/runtimeConfig'
import { getStoredInstance } from '@/services/instanceConfig'

/** One webhook as list_channel_webhooks returns it (db_schema channel_webhook_json). */
export interface ChannelWebhook {
  id: string
  server_id: string
  channel_id: string
  channel_name: string
  name: string
  avatar_url: string | null
  /** Last 4 characters of the token. */
  token_hint: string
  is_active: boolean
  created_by: string | null
  created_by_username: string | null
  created_by_display_name: string | null
  created_at: string
  last_used_at: string | null
  use_count: number
}

/** create_channel_webhook and regenerate_channel_webhook_token add the token, returned once. */
export interface ChannelWebhookWithToken extends ChannelWebhook {
  token: string
}

/** A channel holds at most this many webhooks (create_channel_webhook). */
export const MAX_WEBHOOKS_PER_CHANNEL = 10

export async function listChannelWebhooks(channelId: string): Promise<ChannelWebhook[]> {
  const { data, error } = await supabase.rpc('list_channel_webhooks', { p_channel_id: channelId })
  if (error) throw error
  return Array.isArray(data) ? (data as ChannelWebhook[]) : []
}

export async function createChannelWebhook(
  channelId: string,
  name: string,
  avatarUrl?: string | null,
): Promise<ChannelWebhookWithToken> {
  const { data, error } = await supabase.rpc('create_channel_webhook', {
    p_channel_id: channelId,
    p_name: name,
    p_avatar_url: avatarUrl?.trim() || null,
  })
  if (error) throw error
  return data as ChannelWebhookWithToken
}

/** An avatar URL of '' clears the avatar; an absent field stays unchanged. */
export async function updateChannelWebhook(
  id: string,
  changes: { name?: string; avatarUrl?: string },
): Promise<ChannelWebhook> {
  const { data, error } = await supabase.rpc('update_channel_webhook', {
    p_id: id,
    p_name: changes.name ?? null,
    p_avatar_url: changes.avatarUrl ?? null,
  })
  if (error) throw error
  return data as ChannelWebhook
}

export async function regenerateChannelWebhookToken(id: string): Promise<ChannelWebhookWithToken> {
  const { data, error } = await supabase.rpc('regenerate_channel_webhook_token', { p_id: id })
  if (error) throw error
  return data as ChannelWebhookWithToken
}

export async function deleteChannelWebhook(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_channel_webhook', { p_id: id })
  if (error) throw error
}

/** Origin serving /webhooks/channels/: the native client's instance, else the federation backend's. */
export function webhookOrigin(): string {
  const stored = getStoredInstance()
  if (stored) return stored.origin.replace(/\/+$/, '')
  const base = runtimeConfig.federationUrl || (typeof window !== 'undefined' ? window.location.origin : '')
  return base.replace(/\/+$/, '')
}

export function channelWebhookUrl(id: string, token: string): string {
  return `${webhookOrigin()}/webhooks/channels/${id}/${token}`
}

const ERROR_KEYS: Record<string, string> = {
  WEBHOOK_CHANNEL_ENCRYPTED: 'webhooks.errors.encrypted',
  WEBHOOK_CHANNEL_UNSUPPORTED: 'webhooks.errors.unsupported',
  WEBHOOK_LIMIT_CHANNEL: 'webhooks.errors.channelLimit',
  WEBHOOK_LIMIT_SERVER: 'webhooks.errors.serverLimit',
  WEBHOOK_INVALID_NAME: 'webhooks.errors.invalidName',
  WEBHOOK_INVALID_AVATAR_URL: 'webhooks.errors.invalidAvatar',
}

/** i18n key for a refusal, read from the code its message opens with; the generic key otherwise. */
export function webhookErrorKey(error: unknown): string {
  const message = typeof (error as { message?: unknown })?.message === 'string'
    ? (error as { message: string }).message
    : ''
  const key = ERROR_KEYS[message.split(':', 1)[0]]
  if (key) return key
  if (message.startsWith('Permission denied')) return 'webhooks.errors.permission'
  return 'webhooks.errors.saveFailed'
}
