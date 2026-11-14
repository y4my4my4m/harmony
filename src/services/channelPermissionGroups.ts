import { Permission } from '@/services/RoleService'

// Permissions are grouped Discord-style rather than as one flat toggle list.
// Only permissions the server resolves per channel are offered. Server-scoped
// ones are absent: MANAGE_SERVER, MANAGE_EMOJIS, VIEW_AUDIT_LOG, the member
// moderation bits, and CREATE_INVITE (an invite names no channel).
// CREATE_PRIVATE_THREADS grants nothing and is absent. MANAGE_ROLES here is
// Discord's Manage Permissions: the channel's overrides. MANAGE_WEBHOOKS
// applies to text channels alone. Editing another user's messages is
// owner/admin-only and lives outside the channel-override surface.
// Group names are channel.edit.groups.<id>; labels and descriptions
// channel.edit.perms.<KEY>.{label,description}.

export interface PermissionGroup {
  id: string
  permissions: Array<{ key: Permission }>
}

const SHARED_GROUPS: PermissionGroup[] = [
  {
    id: 'general',
    permissions: [
      { key: Permission.VIEW_CHANNEL },
      { key: Permission.MANAGE_CHANNELS },
      { key: Permission.MANAGE_ROLES },
      { key: Permission.MANAGE_WEBHOOKS },
    ],
  },
  {
    id: 'messages',
    permissions: [
      { key: Permission.SEND_MESSAGES },
      { key: Permission.EMBED_LINKS },
      { key: Permission.ATTACH_FILES },
      { key: Permission.ADD_REACTIONS },
      { key: Permission.USE_EXTERNAL_EMOJIS },
      { key: Permission.MENTION_EVERYONE },
      { key: Permission.MANAGE_MESSAGES },
      { key: Permission.PIN_MESSAGES },
      { key: Permission.READ_MESSAGE_HISTORY },
    ],
  },
  {
    id: 'threads',
    permissions: [
      { key: Permission.CREATE_PUBLIC_THREADS },
      { key: Permission.SEND_MESSAGES_IN_THREADS },
    ],
  },
]

// Webhooks post to text channels (assert_webhook_channel).
const TEXT_ONLY: ReadonlySet<Permission> = new Set([Permission.MANAGE_WEBHOOKS])

const VOICE_GROUP: PermissionGroup = {
  id: 'voice',
  permissions: [
    { key: Permission.CONNECT },
    { key: Permission.SPEAK },
    { key: Permission.STREAM },
    { key: Permission.MUTE_MEMBERS },
    { key: Permission.DEAFEN_MEMBERS },
    { key: Permission.MOVE_MEMBERS },
    { key: Permission.USE_SOUNDBOARD },
    { key: Permission.USE_EXTERNAL_SOUNDS },
  ],
}

const VOICE_CHANNEL_GROUPS: PermissionGroup[] = [
  ...SHARED_GROUPS.map(g => ({ ...g, permissions: g.permissions.filter(p => !TEXT_ONLY.has(p.key)) })),
  VOICE_GROUP,
]

/** The groups a channel of `type` (0 text, 1 voice) offers. */
export function channelPermissionGroups(type: number | undefined): PermissionGroup[] {
  return type === 1 ? VOICE_CHANNEL_GROUPS : SHARED_GROUPS
}

/** A category holds text and voice channels: every group, as Discord's category settings. */
export const CATEGORY_PERMISSION_GROUPS: PermissionGroup[] = [...SHARED_GROUPS, VOICE_GROUP]
