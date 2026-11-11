/**
 * Discord permission flag -> Harmony permission name, for "Migrate from Discord".
 * Copy of the bridge's DISCORD_TO_HARMONY_PERMISSION (33 rows) plus ADMINISTRATOR, with the
 * discord.js PermissionFlagsBits values written as bigint literals (bot-gateway has no discord.js).
 * Bit positions on the Harmony side come from the permission_bit_names RPC (index = position).
 */
export const DISCORD_TO_HARMONY: ReadonlyArray<[bigint, string]> = [
  [1n << 3n, 'ADMINISTRATOR'], // Administrator
  [1n << 10n, 'VIEW_CHANNEL'], // ViewChannel
  [1n << 4n, 'MANAGE_CHANNELS'], // ManageChannels
  [1n << 28n, 'MANAGE_ROLES'], // ManageRoles
  [1n << 30n, 'MANAGE_EMOJIS'], // ManageGuildExpressions
  [1n << 7n, 'VIEW_AUDIT_LOG'], // ViewAuditLog
  [1n << 29n, 'MANAGE_WEBHOOKS'], // ManageWebhooks
  [1n << 5n, 'MANAGE_SERVER'], // ManageGuild
  [1n << 0n, 'CREATE_INVITE'], // CreateInstantInvite
  [1n << 1n, 'KICK_MEMBERS'], // KickMembers
  [1n << 2n, 'BAN_MEMBERS'], // BanMembers
  [1n << 40n, 'TIMEOUT_MEMBERS'], // ModerateMembers
  [1n << 11n, 'SEND_MESSAGES'], // SendMessages
  [1n << 38n, 'SEND_MESSAGES_IN_THREADS'], // SendMessagesInThreads
  [1n << 35n, 'CREATE_PUBLIC_THREADS'], // CreatePublicThreads
  [1n << 36n, 'CREATE_PRIVATE_THREADS'], // CreatePrivateThreads
  [1n << 14n, 'EMBED_LINKS'], // EmbedLinks
  [1n << 15n, 'ATTACH_FILES'], // AttachFiles
  [1n << 6n, 'ADD_REACTIONS'], // AddReactions
  [1n << 18n, 'USE_EXTERNAL_EMOJIS'], // UseExternalEmojis
  [1n << 17n, 'MENTION_EVERYONE'], // MentionEveryone
  [1n << 13n, 'MANAGE_MESSAGES'], // ManageMessages
  [1n << 16n, 'READ_MESSAGE_HISTORY'], // ReadMessageHistory
  [1n << 51n, 'PIN_MESSAGES'], // PinMessages
  [1n << 20n, 'CONNECT'], // Connect
  [1n << 21n, 'SPEAK'], // Speak
  [1n << 9n, 'STREAM'], // Stream
  [1n << 22n, 'MUTE_MEMBERS'], // MuteMembers
  [1n << 23n, 'DEAFEN_MEMBERS'], // DeafenMembers
  [1n << 24n, 'MOVE_MEMBERS'], // MoveMembers
  [1n << 42n, 'USE_SOUNDBOARD'], // UseSoundboard
  [1n << 45n, 'USE_EXTERNAL_SOUNDS'], // UseExternalSounds
  [1n << 26n, 'CHANGE_NICKNAME'], // ChangeNickname
  [1n << 27n, 'MANAGE_NICKNAMES'], // ManageNicknames
]

/** Discord permission bitfield (decimal string) to a Harmony mask (decimal string). */
/** The roles snapshot discord_migration_store_discord_roles stores: Discord roles with Harmony permission masks. */
export function buildRolesSnapshot(
  roles: Array<{ id: string; name: string; color: number; position: number; permissions: string }>,
  bitNames: string[],
) {
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    harmony_permissions: toHarmonyMask(r.permissions, bitNames),
  }))
}

export function toHarmonyMask(discordPermissions: string, bitNames: string[]): string {
  const discordBits = BigInt(discordPermissions)
  const positions = new Map<string, number>()
  bitNames.forEach((name, i) => { if (!positions.has(name)) positions.set(name, i) })
  let mask = 0n
  for (const [flag, name] of DISCORD_TO_HARMONY) {
    if ((discordBits & flag) !== flag) continue
    const bit = positions.get(name)
    if (bit !== undefined) mask |= 1n << BigInt(bit)
  }
  return mask.toString()
}
