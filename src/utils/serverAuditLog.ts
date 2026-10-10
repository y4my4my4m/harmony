/**
 * Display text for server audit log entries (get_server_audit_log rows).
 */
import { PERMISSION_BITS, type Permission } from '@/services/RoleService'
import type { ServerAuditEntry } from '@/services/ServerAuditLogService'

export type AuditTranslate = (key: string, named?: Record<string, unknown>, plural?: number) => string

/** Filter choices; get_server_audit_log matches a kind against the action's prefix. */
export const AUDIT_KINDS = [
  'channel', 'category', 'override', 'role', 'member', 'message',
  'server', 'settings', 'invite', 'emoji', 'sound', 'bot',
] as const

const KNOWN_ACTIONS = new Set([
  'channel.create', 'channel.update', 'channel.delete', 'channel.reorder',
  'category.create', 'category.update', 'category.delete', 'category.reorder',
  'override.create', 'override.update', 'override.delete',
  'role.create', 'role.update', 'role.delete', 'role.reorder',
  'member.role_add', 'member.role_remove', 'member.kick', 'member.ban', 'member.unban',
  'member.timeout', 'member.timeout_remove',
  'message.delete',
  'server.update', 'settings.update',
  'invite.create', 'invite.delete',
  'emoji.create', 'emoji.update', 'emoji.delete',
  'sound.create', 'sound.update', 'sound.delete',
  'bot.add', 'bot.update', 'bot.remove',
])

const PERMISSION_FIELDS = new Set(['permissions', 'allow_permissions', 'deny_permissions'])

/** Stored as paths or structured settings; the entry says that they changed, not how. */
const OPAQUE_FIELDS = new Set([
  'icon', 'banner', 'icon_url', 'rules', 'invite_permissions', 'moderation_settings', 'allowed_channel_ids',
])

const LABELLED_FIELDS = new Set([
  'name', 'description', 'category', 'slowmode_seconds', 'color', 'permissions', 'mentionable', 'hoist',
  'icon_url', 'unicode_emoji', 'is_admin', 'allow_permissions', 'deny_permissions', 'icon', 'banner',
  'public', 'allow_cross_server_emojis', 'federation_enabled', 'invite_code', 'rules', 'owner',
  'invite_permissions', 'moderation_settings', 'default_message_notifications', 'newcomer_alerts',
  'system_messages_enabled', 'default_role', 'system_channel', 'read_messages', 'send_messages',
  'manage_messages', 'embed_links', 'attach_files', 'mention_everyone', 'add_reactions',
  'manage_channels', 'kick_members', 'ban_members', 'manage_roles', 'allowed_channel_ids',
  'max_uses', 'expires_at', 'temporary', 'emoji', 'volume', 'allow_cross_server_sounds',
])

/** Shown in the sentence itself, or a channel type number with no user-facing meaning. */
const SENTENCE_FIELDS = new Set(['type'])

export type AuditSegmentRole = 'actor' | 'target' | 'subject'

export interface AuditSegment {
  text: string
  role?: AuditSegmentRole
}

export interface AuditChangeLine {
  field: string
  from: string | null
  to: string | null
  added?: string[]
  removed?: string[]
}

/** 'MANAGE_CHANNELS' -> 'Manage Channels'. */
function permissionLabel(permission: string): string {
  return permission
    .toLowerCase()
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Names of the permission bits set in mask, in bit order. */
export function permissionNames(mask: unknown): string[] {
  let bits: bigint
  try {
    bits = BigInt(typeof mask === 'number' || typeof mask === 'string' || typeof mask === 'bigint' ? mask : 0)
  } catch {
    return []
  }
  return (Object.entries(PERMISSION_BITS) as Array<[Permission, number]>)
    .sort((a, b) => a[1] - b[1])
    .filter(([, bit]) => (bits & (1n << BigInt(bit))) !== 0n)
    .map(([permission]) => permissionLabel(permission))
}

export function auditActorName(entry: ServerAuditEntry, t: AuditTranslate): string {
  if (entry.actor_id) return entry.actor_display_name || entry.actor_username || t('serverAuditLog.unknownUser')
  if (entry.actor_bot_id) return entry.actor_bot_name || t('serverAuditLog.unknownBot')
  if (entry.details?.automod) return t('serverAuditLog.automod')
  return t('serverAuditLog.system')
}

export function auditTargetName(entry: ServerAuditEntry, t: AuditTranslate): string {
  const name = entry.target_display_name || entry.target_name
  if (!name) return t('serverAuditLog.unknownTarget')
  if (entry.target_type === 'channel') return `#${name}`
  if (entry.target_type === 'emoji') return `:${name}:`
  return name
}

// U+2063 INVISIBLE SEPARATOR brackets each placeholder name in the translated sentence.
const TOKEN = '\u2063'

/**
 * The entry's sentence as text runs; names are runs with a role so they can be styled.
 * Placeholders are substituted after translation, so word order follows the locale.
 */
export function describeAuditEntry(
  entry: ServerAuditEntry,
  t: AuditTranslate,
  formatDate: (iso: string) => string,
): AuditSegment[] {
  const details = entry.details ?? {}
  const values: Record<string, AuditSegment> = {
    actor: { text: auditActorName(entry, t), role: 'actor' },
    target: { text: auditTargetName(entry, t), role: 'target' },
    subject: {
      text: details.role_name ?? details.user_name ?? t('serverAuditLog.unknownTarget'),
      role: 'subject',
    },
    channel: { text: details.channel_name ? `#${details.channel_name}` : t('serverAuditLog.unknownTarget'), role: 'subject' },
  }
  const count = Number(details.count ?? 1) || 1
  const named: Record<string, unknown> = {
    count,
    until: details.until ? formatDate(String(details.until)) : '',
    action: entry.action,
  }
  for (const key of Object.keys(values)) named[key] = `${TOKEN}${key}${TOKEN}`

  const key = KNOWN_ACTIONS.has(entry.action)
    ? `serverAuditLog.actions.${entry.action.replace('.', '_')}`
    : 'serverAuditLog.actions.unknown'
  const sentence = t(key, named, count)

  const segments: AuditSegment[] = []
  sentence.split(new RegExp(`${TOKEN}(\\w+)${TOKEN}`)).forEach((part, index) => {
    if (index % 2 === 1) {
      segments.push(values[part] ?? { text: part })
    } else if (part) {
      segments.push({ text: part })
    }
  })
  return segments
}

function fieldLabel(field: string, t: AuditTranslate): string {
  if (LABELLED_FIELDS.has(field)) return t(`serverAuditLog.fields.${field}`)
  return field.replace(/_/g, ' ')
}

function formatValue(field: string, value: unknown, t: AuditTranslate, formatDate: (iso: string) => string): string {
  if (value === null || value === undefined) return t('serverAuditLog.value.none')
  if (typeof value === 'boolean') return t(value ? 'serverAuditLog.value.on' : 'serverAuditLog.value.off')
  if (field === 'slowmode_seconds' && typeof value === 'number') return t('serverAuditLog.value.seconds', { n: value })
  if (field === 'expires_at' && typeof value === 'string') return formatDate(value)
  // server_sounds.volume, 0-1.
  if (field === 'volume' && typeof value === 'number') return `${Math.round(value * 100)}%`
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value
  return t('serverAuditLog.value.changed')
}

/** A created or deleted row's unset fields: no line for them. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === false || value === 0 || value === ''
    || (Array.isArray(value) && value.length === 0)
}

/** One line per changed field; permission masks as added and removed names. */
export function auditChangeLines(
  entry: ServerAuditEntry,
  t: AuditTranslate,
  formatDate: (iso: string) => string,
): AuditChangeLine[] {
  const lines: AuditChangeLine[] = []
  const creates = entry.action.endsWith('.create') || entry.action.endsWith('.delete') || entry.action === 'bot.add'

  for (const [field, change] of Object.entries(entry.changes ?? {})) {
    if (SENTENCE_FIELDS.has(field) || (creates && field === 'name')) continue
    if (creates && isBlank(change.new ?? change.old)) continue
    const label = fieldLabel(field, t)
    if (PERMISSION_FIELDS.has(field)) {
      const before = new Set(permissionNames(change.old))
      const after = permissionNames(change.new)
      const added = after.filter(name => !before.has(name))
      const removed = [...before].filter(name => !after.includes(name))
      if (added.length || removed.length) lines.push({ field: label, from: null, to: null, added, removed })
      continue
    }
    if (OPAQUE_FIELDS.has(field)) {
      lines.push({ field: label, from: null, to: t('serverAuditLog.value.changed') })
      continue
    }
    lines.push({
      field: label,
      from: 'old' in change ? formatValue(field, change.old, t, formatDate) : null,
      to: 'new' in change ? formatValue(field, change.new, t, formatDate) : null,
    })
  }

  const details = entry.details ?? {}
  if (entry.action.endsWith('.reorder') && details.items && typeof details.items === 'object') {
    const prefix = entry.action === 'channel.reorder' ? '#' : ''
    for (const item of Object.values(details.items as Record<string, { name?: string; old?: number; new?: number }>)) {
      lines.push({
        field: `${prefix}${item.name ?? t('serverAuditLog.unknownTarget')}`,
        from: item.old === undefined || item.old === null ? null : String(item.old),
        to: item.new === undefined || item.new === null ? null : String(item.new),
      })
    }
  }
  if (entry.action === 'invite.create') {
    for (const field of ['max_uses', 'expires_at', 'temporary']) {
      if (!isBlank(details[field])) {
        lines.push({ field: fieldLabel(field, t), from: null, to: formatValue(field, details[field], t, formatDate) })
      }
    }
  }
  if ((entry.action === 'member.kick' || entry.action === 'member.ban') && details.messages_deleted) {
    lines.push({
      field: t('serverAuditLog.fields.messages_deleted'),
      from: null,
      to: String(details.messages_deleted),
    })
  }
  return lines
}
