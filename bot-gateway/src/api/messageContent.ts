import { supabase } from '../config/supabase.js'
import { botCanSeeChannel, loadEveryoneLayers, loadInstall } from '../auth/botPermissions.js'
import { applyBridgeAttachmentPolicy } from '../utils/mirrorExternalMedia.js'
import { stripBotSuppliedPaths } from '../utils/messageMedia.js'

// The displayed author of a relayed message (src/utils/messageAuthor.ts in the client). Kept
// only from a bridge bot whose bridge relays the channel (bridgePairsChannel).
export const BRIDGE_AUTHOR_KEYS = new Set(['discord_user', 'bridge_source'])

/** EmbedProvider in the client's src/types/chat.ts. */
const EMBED_PROVIDERS = new Set(['harmony-post', 'harmony-invite', 'fediverse-post', 'youtube', 'spotify', 'generic'])

/** True when bot metadata names the relayed author, which only a relaying bridge may. */
export function claimsBridgeAuthor(input: unknown): boolean {
  return !!input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).some((key) => BRIDGE_AUTHOR_KEYS.has(key))
}

/** An embed part as the client reads it (EmbedContent), or null. */
export function embedPart(part: Record<string, unknown>): Record<string, unknown> | null {
  const { url, provider, previewId, collapsed } = part
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\/\S+$/i.test(url)) return null
  if (typeof provider !== 'string' || !EMBED_PROVIDERS.has(provider)) return null
  if (typeof previewId !== 'string' || !previewId || previewId.length > 2048) return null
  return { type: 'embed', url, provider, previewId, ...(typeof collapsed === 'boolean' ? { collapsed } : {}) }
}

/**
 * Bot-supplied parts without system parts, which are server-generated join and leave
 * notices, and with embed parts reduced to their fields or dropped when malformed.
 */
export function botContentParts(parts: unknown[]): any[] {
  const out: any[] = []
  for (const part of parts) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const type = (part as { type?: unknown }).type
      if (type === 'system') continue
      if (type === 'embed') {
        const embed = embedPart(part as Record<string, unknown>)
        if (embed) out.push(embed)
        continue
      }
    }
    out.push(part)
  }
  return out
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// role_mention roleId of @here (db_schema/migrations/20261011600001_here_mention.sql).
const HERE_ROLE_ID = 'here'

// src/utils/massMentions.ts TYPED_MASS_MENTION: the handle grammar's boundaries, no host.
const TYPED_MASS_MENTION = /(?<![\p{L}\p{N}_@/])@(everyone|here)(?![\p{L}\p{N}_@-]|\.[\p{L}\p{N}_-])/u
// Fenced code, inline code and URLs hold no mention (src/utils/unifiedContentProcessing opaqueRanges).
const OPAQUE_TEXT = /```[\s\S]*?```|`[^`\n]+`|\bhttps?:\/\/\S+/g

/**
 * Text content with each typed bare @everyone or @here outside code and URLs as its role_mention
 * part: `everyoneRoleId` (the server's default role) and roleId `here`. Discord pings the
 * lowercase words only; any other spelling, and @everyone without a default role, stays text.
 */
export function typedMassMentionParts(text: string, everyoneRoleId: string | null): any[] {
  const opaque: Array<[number, number]> = []
  for (const m of text.matchAll(OPAQUE_TEXT)) opaque.push([m.index!, m.index! + m[0].length])
  const parts: any[] = []
  let last = 0
  for (const m of text.matchAll(new RegExp(TYPED_MASS_MENTION, 'gu'))) {
    const at = m.index!
    if (opaque.some(([start, end]) => at >= start && at < end)) continue
    const here = m[1] === HERE_ROLE_ID
    if (!here && !everyoneRoleId) continue
    if (at > last) parts.push({ type: 'text', text: text.slice(last, at) })
    parts.push(here
      ? { type: 'role_mention', roleId: HERE_ROLE_ID, roleName: HERE_ROLE_ID, roleColor: null }
      : { type: 'role_mention', roleId: everyoneRoleId, roleName: 'everyone', roleColor: null })
    last = at + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return parts
}

export async function channelServerId(channelId: string): Promise<string | null> {
  const { data: channel } = await supabase
    .from('channels')
    .select('server_id')
    .eq('id', channelId)
    .maybeSingle()
  return channel?.server_id ?? null
}

/** The channels among `channels` the bot sees (botCanSeeChannel); none on a failed lookup. */
export async function visibleChannels<T extends { id: string }>(botId: string, serverId: string, channels: T[]): Promise<T[]> {
  if (channels.length === 0) return []
  const install = await loadInstall(botId, serverId)
  if (!install) return []
  const layers = await loadEveryoneLayers(channels.map((c) => ({ id: c.id, server_id: serverId })))
  return channels.filter((c) => {
    const layer = layers.get(c.id)
    return layer !== undefined && botCanSeeChannel(install, layer, c.id)
  })
}

/**
 * Server-scoped permission check for server-wide actions such as
 * channel/category creation.
 */
export async function checkServerPermission(botId: string, serverId: string, permission: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('check_bot_permission', {
    p_bot_id: botId,
    p_server_id: serverId,
    p_permission: permission,
  })
  if (error) {
    console.error(`[checkServerPermission] RPC error: ${error.message}`)
    return false
  }
  return data === true
}

/**
 * Discord's reading of string content: a typed @everyone or @here pings for a bot holding
 * mention_everyone in the channel's server (typedMassMentionParts on the text part
 * formatContent made of it) and stays text otherwise. Content sent as parts and relayed
 * content keep their text parts: a relaying bot's right is not its author's.
 */
async function typedMassMentions(parts: any[], content: unknown, channelId: string, botId: string): Promise<any[]> {
  if (typeof content !== 'string' || parts[0]?.type !== 'text' || parts[0].text !== content) return parts
  if (!TYPED_MASS_MENTION.test(content)) return parts
  const serverId = await channelServerId(channelId)
  if (!serverId || !(await checkServerPermission(botId, serverId, 'mention_everyone'))) return parts
  const { data: role } = await supabase
    .from('server_roles')
    .select('id')
    .eq('server_id', serverId)
    .eq('is_default', true)
    .maybeSingle()
  return [...typedMassMentionParts(content, (role as { id?: string } | null)?.id ?? null), ...parts.slice(1)]
}

/**
 * role_mention and channel_mention parts against the channel's server: a role or channel of
 * that server keeps its part, carrying the stored name (and the role's color); any other part
 * of those types becomes the text `@name` or `#name`. @everyone (the server's default role)
 * and @here (roleId `here`) keep their part only for a bot holding mention_everyone there, and
 * otherwise become the text `@everyone` or `@here`. Notifications of a kept role mention
 * follow handle_role_mention_notifications (MENTION_EVERYONE, mentionable roles).
 */
export async function resolveMentionParts(parts: any[], channelId: string | null | undefined, botId: string): Promise<any[]> {
  if (!Array.isArray(parts)) return parts
  const isRole = (p: any) => p?.type === 'role_mention'
  const isChannel = (p: any) => p?.type === 'channel_mention'
  if (!parts.some((p) => isRole(p) || isChannel(p))) return parts

  const serverId = channelId ? await channelServerId(channelId) : null
  const uuids = (values: unknown[]) =>
    [...new Set(values.filter((v): v is string => typeof v === 'string' && UUID_PATTERN.test(v)))]
  const roleIds = uuids(parts.filter(isRole).map((p) => p.roleId))
  const channelIds = uuids(parts.filter(isChannel).map((p) => p.channelId))

  const roles = new Map<string, { name: string; color: string | null; isDefault: boolean }>()
  if (serverId && roleIds.length > 0) {
    const { data } = await supabase
      .from('server_roles')
      .select('id, name, color, is_default')
      .eq('server_id', serverId)
      .in('id', roleIds)
    for (const r of (data ?? []) as Array<{ id: string; name: string; color: string | null; is_default?: boolean | null }>) {
      roles.set(r.id, { name: r.name, color: r.color ?? null, isDefault: r.is_default === true })
    }
  }
  const isHere = (p: any) => isRole(p) && p.roleId === HERE_ROLE_ID
  const pingsAll = parts.some((p) => isHere(p) || (isRole(p) && roles.get(p.roleId)?.isDefault))
  const canPingAll = pingsAll && !!serverId && (await checkServerPermission(botId, serverId, 'mention_everyone'))
  const channels = new Map<string, string>()
  if (serverId && channelIds.length > 0) {
    const { data } = await supabase
      .from('channels')
      .select('id, name')
      .eq('server_id', serverId)
      .in('id', channelIds)
    const named = await visibleChannels(botId, serverId, (data ?? []) as Array<{ id: string; name: string }>)
    for (const c of named) channels.set(c.id, c.name)
  }

  const label = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() !== '' ? value : fallback
  return parts.map((part) => {
    if (isHere(part)) {
      if (!canPingAll) return { type: 'text', text: `@${HERE_ROLE_ID}` }
      return { type: 'role_mention', roleId: HERE_ROLE_ID, roleName: HERE_ROLE_ID, roleColor: null }
    }
    if (isRole(part)) {
      const role = roles.get(part.roleId)
      if (!role) return { type: 'text', text: `@${label(part.roleName, 'role')}` }
      if (role.isDefault && !canPingAll) return { type: 'text', text: `@${role.name.replace(/^@/, '')}` }
      return { type: 'role_mention', roleId: part.roleId, roleName: role.name, roleColor: role.color }
    }
    if (isChannel(part)) {
      const name = channels.get(part.channelId)
      if (name === undefined) return { type: 'text', text: `#${label(part.name, 'channel')}` }
      const out: Record<string, unknown> = { type: 'channel_mention', channelId: part.channelId, serverId, name }
      if (typeof part.messageId === 'string' && UUID_PATTERN.test(part.messageId)) out.messageId = part.messageId
      return out
    }
    return part
  })
}

export function formatContent(content: string | any[], embeds?: any[]): any[] {
  const parts: any[] = []
  
  if (Array.isArray(content)) {
    parts.push(...botContentParts(stripBotSuppliedPaths(content)))
  } else if (content) {
    parts.push({ type: 'text', text: content })
  }
  
  if (Array.isArray(embeds) && embeds.length > 0) {
    parts.push(...botContentParts(embeds.map(e => ({ ...e, type: 'embed' }))))
  }
  
  return parts
}

/**
 * The content pipeline of POST /channels/:id/messages: formatContent, typedMassMentions
 * (skipped when the metadata claims a bridge author), resolveMentionParts, then the instance
 * attachment policy. The result may be empty; callers decide what an empty message means.
 */
export async function prepareBotMessageContent(input: {
  content: unknown
  embeds?: unknown
  metadata?: unknown
  channelId: string
  botId: string
}): Promise<unknown[]> {
  const { content, embeds, metadata, channelId, botId } = input
  const formatted = formatContent(content as string | any[], embeds as any[] | undefined)
  const typed = claimsBridgeAuthor(metadata) ? formatted
    : await typedMassMentions(formatted, content, channelId, botId)
  return applyBridgeAttachmentPolicy(await resolveMentionParts(typed, channelId, botId), botId, channelId)
}
