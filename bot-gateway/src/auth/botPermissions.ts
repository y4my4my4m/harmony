import { supabase } from '../config/supabase.js'

// Role-permission bit positions. Mirrors PERMISSION_BITS in src/services/RoleService.ts and the
// bit map of get_user_permissions().
export const PERMISSION_BIT = {
  ADMINISTRATOR: 0,
  VIEW_CHANNEL: 1,
  MANAGE_CHANNELS: 2,
  MANAGE_ROLES: 3,
  MANAGE_EMOJIS: 4,
  VIEW_AUDIT_LOG: 5,
  MANAGE_WEBHOOKS: 6,
  MANAGE_SERVER: 7,
  CREATE_INVITE: 8,
  KICK_MEMBERS: 9,
  BAN_MEMBERS: 10,
  TIMEOUT_MEMBERS: 11,
  SEND_MESSAGES: 12,
  SEND_MESSAGES_IN_THREADS: 13,
  CREATE_PUBLIC_THREADS: 14,
  CREATE_PRIVATE_THREADS: 15,
  EMBED_LINKS: 16,
  ATTACH_FILES: 17,
  ADD_REACTIONS: 18,
  USE_EXTERNAL_EMOJIS: 19,
  MENTION_EVERYONE: 20,
  MANAGE_MESSAGES: 21,
  READ_MESSAGE_HISTORY: 22,
  PIN_MESSAGES: 23,
  CONNECT: 24,
  SPEAK: 25,
  STREAM: 26,
  MUTE_MEMBERS: 27,
  DEAFEN_MEMBERS: 28,
  MOVE_MEMBERS: 29,
  USE_SOUNDBOARD: 30,
  USE_EXTERNAL_SOUNDS: 31,
} as const

export type PermissionName = keyof typeof PERMISSION_BIT

export function permissionMask(...names: PermissionName[]): bigint {
  return names.reduce((mask, name) => mask | (1n << BigInt(PERMISSION_BIT[name])), 0n)
}

export const ADMINISTRATOR = permissionMask('ADMINISTRATOR')
export const VIEW_CHANNEL = permissionMask('VIEW_CHANNEL')

// Masks are compared as unsigned 64-bit values; the columns are signed bigint.
export const ALL_BITS = (1n << 64n) - 1n

export function u64(mask: bigint): bigint {
  return BigInt.asUintN(64, mask)
}

/**
 * A bigint column value or request field: decimal string, safe-integer number or bigint, within
 * the signed 64-bit range. PostgREST serialises bigint as a JSON number, so a stored mask above
 * 2^53 arrives inexact and reads as null.
 */
export function parseMask(value: unknown): bigint | null {
  let mask: bigint
  if (typeof value === 'bigint') {
    mask = value
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null
    mask = BigInt(value)
  } else if (typeof value === 'string' && /^-?\d{1,20}$/.test(value.trim())) {
    mask = BigInt(value.trim())
  } else {
    return null
  }
  return BigInt.asIntN(64, mask) === mask ? mask : null
}

export type InstallRow = Record<string, unknown>

// bot_server_permissions flag -> role-permission bits. Production carries flags the migrations
// lack (view_channels, read_message_history, manage_roles, ...); an absent column reads as false.
// send_tts_messages, change_nickname and manage_nicknames have no role-permission bit.
const INSTALL_FLAG_BITS: Readonly<Record<string, bigint>> = {
  read_messages: permissionMask('VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'),
  view_channels: permissionMask('VIEW_CHANNEL'),
  read_message_history: permissionMask('READ_MESSAGE_HISTORY'),
  send_messages: permissionMask('SEND_MESSAGES'),
  manage_messages: permissionMask('MANAGE_MESSAGES'),
  embed_links: permissionMask('EMBED_LINKS'),
  attach_files: permissionMask('ATTACH_FILES'),
  mention_everyone: permissionMask('MENTION_EVERYONE'),
  use_external_emojis: permissionMask('USE_EXTERNAL_EMOJIS'),
  add_reactions: permissionMask('ADD_REACTIONS'),
  manage_channels: permissionMask('MANAGE_CHANNELS'),
  manage_roles: permissionMask('MANAGE_ROLES'),
  manage_webhooks: permissionMask('MANAGE_WEBHOOKS'),
  create_instant_invite: permissionMask('CREATE_INVITE'),
  kick_members: permissionMask('KICK_MEMBERS'),
  ban_members: permissionMask('BAN_MEMBERS'),
  connect_voice: permissionMask('CONNECT'),
  speak: permissionMask('SPEAK'),
  mute_members: permissionMask('MUTE_MEMBERS'),
  deafen_members: permissionMask('DEAFEN_MEMBERS'),
  move_members: permissionMask('MOVE_MEMBERS'),
}

export function installMask(install: InstallRow): bigint {
  let mask = 0n
  for (const [flag, bits] of Object.entries(INSTALL_FLAG_BITS)) {
    if (install[flag] === true) mask |= bits
  }
  return mask
}

// Route parameters keep the caller's case; PostgREST returns uuids lowercase.
function listsChannel(ids: unknown[], channelId: string): boolean {
  const wanted = channelId.toLowerCase()
  return ids.some((id) => typeof id === 'string' && id.toLowerCase() === wanted)
}

// allowed_channel_ids: NULL, or no such column, leaves the install unrestricted; an array, empty
// included, is the complete list of channels the bot may use.
export function installAllowsChannel(install: InstallRow, channelId: string): boolean {
  const ids = install.allowed_channel_ids
  if (ids === null || ids === undefined) return true
  return Array.isArray(ids) && listsChannel(ids, channelId)
}

/**
 * The channel is named in allowed_channel_ids, which grants the bot VIEW_CHANNEL there and the
 * install's write flags whatever @everyone's override denies.
 */
export function installGrantsChannel(install: InstallRow, channelId: string): boolean {
  const ids = install.allowed_channel_ids
  return Array.isArray(ids) && listsChannel(ids, channelId)
}

/** @everyone's server mask and its override on one channel, unsigned. */
export interface EveryoneLayer {
  permissions: bigint
  allow: bigint
  deny: bigint
}

/**
 * The bot's permissions in a channel. Mirrors get_user_permissions() for a principal whose only
 * roles are @everyone and the install's bits: bots have no user_roles rows, and no role or member
 * override can name a bot. Zero outside allowed_channel_ids. The allowed_channel_ids grant is
 * absent: this mask bounds override writes, and a granted bot does not lift a channel's
 * @everyone deny for others.
 */
export function botChannelMask(install: InstallRow, layer: EveryoneLayer, channelId: string): bigint {
  if (!installAllowsChannel(install, channelId)) return 0n
  const base = layer.permissions | installMask(install)
  if ((base & ADMINISTRATOR) !== 0n) return ALL_BITS
  return (base & ~layer.deny) | layer.allow
}

/**
 * The bot sees the channel: listed in allowed_channel_ids, whatever @everyone's override denies,
 * or, without a list, VIEW_CHANNEL in botChannelMask.
 */
export function botCanSeeChannel(install: InstallRow, layer: EveryoneLayer, channelId: string): boolean {
  if (installGrantsChannel(install, channelId)) return true
  return (botChannelMask(install, layer, channelId) & VIEW_CHANNEL) !== 0n
}

export function botCanReadChannel(install: InstallRow, layer: EveryoneLayer, channelId: string): boolean {
  return install.read_messages === true && botCanSeeChannel(install, layer, channelId)
}

/** Install flags that gate channel writes, and the role-permission bit each needs in the channel. */
export const CHANNEL_WRITE_BITS = {
  send_messages: permissionMask('SEND_MESSAGES'),
  manage_messages: permissionMask('MANAGE_MESSAGES'),
  add_reactions: permissionMask('ADD_REACTIONS'),
} as const

export type ChannelWriteFlag = keyof typeof CHANNEL_WRITE_BITS

/**
 * A write in the channel: botCanSeeChannel, and for a flag, the install's flag and either the
 * channel listed in allowed_channel_ids or the flag's bit in botChannelMask. A null flag is a
 * write needing visibility alone, such as deleting the bot's own message.
 */
export function botCanWriteChannel(
  install: InstallRow,
  layer: EveryoneLayer,
  channelId: string,
  flag: ChannelWriteFlag | null,
): boolean {
  if (!botCanSeeChannel(install, layer, channelId)) return false
  if (flag === null) return true
  if (install[flag] !== true) return false
  if (installGrantsChannel(install, channelId)) return true
  return (botChannelMask(install, layer, channelId) & CHANNEL_WRITE_BITS[flag]) !== 0n
}

// Bits a bot may set on a role: the install's and @everyone's, which every member already holds.
export function grantableRoleBits(install: InstallRow, everyonePermissions: bigint): bigint {
  return (everyonePermissions | installMask(install)) & ~ADMINISTRATOR
}

export interface RoleRow {
  id: string
  position?: number | null
  permissions?: unknown
  is_default?: boolean | null
  is_admin?: boolean | null
}

// A role whose mask does not parse counts as an administrator role.
export function isAdminRole(role: RoleRow): boolean {
  if (role.is_admin === true) return true
  const mask = parseMask(role.permissions ?? 0)
  return mask === null || (u64(mask) & ADMINISTRATOR) !== 0n
}

/**
 * Exclusive upper bound on role positions a bot may create, move to, edit or delete. Bots hold no
 * roles, so the installer's highest role stands in: get_user_highest_role_position(), unbounded
 * for the server owner and 0 without roles. No administrator role is reachable either.
 */
export function rolePositionCap(
  roles: RoleRow[],
  installerIsOwner: boolean,
  installerRoleIds: ReadonlySet<string>,
): number {
  let cap = installerIsOwner ? Number.POSITIVE_INFINITY : 0
  if (!installerIsOwner) {
    for (const role of roles) {
      if (installerRoleIds.has(role.id)) cap = Math.max(cap, role.position ?? 0)
    }
  }
  for (const role of roles) {
    if (isAdminRole(role)) cap = Math.min(cap, role.position ?? 0)
  }
  return cap
}

/** Bits a channel override write makes effective: allow bits added, deny bits lifted. */
export function overrideGrants(
  before: { allow: bigint; deny: bigint } | null,
  after: { allow: bigint; deny: bigint },
): bigint {
  const oldAllow = before?.allow ?? 0n
  const oldDeny = before?.deny ?? 0n
  return (after.allow & ~oldAllow) | (oldDeny & ~after.deny)
}

/**
 * Active install of a bot in a server, or null when absent or unreadable. Selects every column:
 * the flag set differs between schema lineages, and naming a column one lacks fails the query.
 */
export async function loadInstall(botId: string, serverId: string): Promise<InstallRow | null> {
  const { data, error } = await supabase
    .from('bot_server_permissions')
    .select('*')
    .eq('bot_id', botId)
    .eq('server_id', serverId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    console.error(`bot_server_permissions lookup failed for bot ${botId} in ${serverId}:`, error.message)
    return null
  }
  return (data as InstallRow | null) ?? null
}

/**
 * @everyone's layer for each channel, keyed by channel id, in two queries. A channel whose lookup
 * fails or whose stored mask does not parse is absent.
 */
export async function loadEveryoneLayers(
  channels: ReadonlyArray<{ id: string; server_id: string }>,
): Promise<Map<string, EveryoneLayer>> {
  const layers = new Map<string, EveryoneLayer>()
  if (channels.length === 0) return layers

  const serverIds = Array.from(new Set(channels.map((c) => c.server_id)))
  const { data: roles, error } = await supabase
    .from('server_roles')
    .select('id, server_id, permissions')
    .in('server_id', serverIds)
    .eq('is_default', true)
  if (error || !Array.isArray(roles)) {
    console.error('@everyone lookup failed:', error?.message)
    return layers
  }
  const everyoneByServer = new Map<string, { id: string; permissions: bigint | null }>()
  for (const role of roles as Array<{ id: string; server_id: string; permissions?: unknown }>) {
    everyoneByServer.set(role.server_id, { id: role.id, permissions: parseMask(role.permissions ?? 0) })
  }

  const { data: overrides, error: overrideError } = await supabase
    .from('channel_permission_overrides')
    .select('channel_id, role_id, allow_permissions, deny_permissions')
    .in('channel_id', channels.map((c) => c.id))
    .is('user_id', null)
  if (overrideError || !Array.isArray(overrides)) {
    console.error('@everyone override lookup failed:', overrideError?.message)
    return layers
  }

  for (const channel of channels) {
    const everyone = everyoneByServer.get(channel.server_id)
    if (!everyone) {
      layers.set(channel.id, { permissions: 0n, allow: 0n, deny: 0n })
      continue
    }
    if (everyone.permissions === null) continue
    let allow = 0n
    let deny = 0n
    let readable = true
    for (const row of overrides as Array<Record<string, unknown>>) {
      if (row.channel_id !== channel.id || row.role_id !== everyone.id) continue
      const rowAllow = parseMask(row.allow_permissions ?? 0)
      const rowDeny = parseMask(row.deny_permissions ?? 0)
      if (rowAllow === null || rowDeny === null) {
        readable = false
        break
      }
      allow |= u64(rowAllow)
      deny |= u64(rowDeny)
    }
    if (readable) layers.set(channel.id, { permissions: u64(everyone.permissions), allow, deny })
  }
  return layers
}

/** Null when a lookup fails or a stored mask does not parse. */
export async function loadEveryoneLayer(serverId: string, channelId: string): Promise<EveryoneLayer | null> {
  const { data: everyone, error } = await supabase
    .from('server_roles')
    .select('id, permissions')
    .eq('server_id', serverId)
    .eq('is_default', true)
    .maybeSingle()
  if (error) {
    console.error(`@everyone lookup failed for ${serverId}:`, error.message)
    return null
  }
  if (!everyone) return { permissions: 0n, allow: 0n, deny: 0n }

  const permissions = parseMask(everyone.permissions ?? 0)
  if (permissions === null) return null

  const { data: overrides, error: overrideError } = await supabase
    .from('channel_permission_overrides')
    .select('allow_permissions, deny_permissions')
    .eq('channel_id', channelId)
    .eq('role_id', everyone.id)
    .is('user_id', null)
  if (overrideError || !Array.isArray(overrides)) {
    console.error(`@everyone override lookup failed for ${channelId}:`, overrideError?.message)
    return null
  }

  let allow = 0n
  let deny = 0n
  for (const row of overrides) {
    const rowAllow = parseMask(row.allow_permissions ?? 0)
    const rowDeny = parseMask(row.deny_permissions ?? 0)
    if (rowAllow === null || rowDeny === null) return null
    allow |= u64(rowAllow)
    deny |= u64(rowDeny)
  }
  return { permissions: u64(permissions), allow, deny }
}
