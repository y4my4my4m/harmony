import type { ReactionActor, ReactionGroup } from '@/types'
import { BOT_NAME_COLOR } from '@/utils/botUtils'

/** metadata.discord_user of a reaction bridged from Discord. */
export type DiscordReactionUser = NonNullable<NonNullable<ReactionActor['metadata']>['discord_user']>

/** One reactor in a reaction group: a Harmony user, a bot, or a bridged Discord user. */
export interface ReactionUser {
  /** Unique within one reaction group. */
  key: string
  /** Profile id, bot id, or Discord user snowflake, per `kind`. */
  id: string
  kind: 'user' | 'bot' | 'discord'
  displayName: string
  /** `@username`, or `@username@domain` for a remote user. */
  handle: string | null
  avatarUrl: string
  userColor: string
  isBridged: boolean
  bridgeSource?: 'discord'
  discordUser?: DiscordReactionUser
}

export interface ReactionBotInfo {
  displayName: string
  avatarUrl: string
  username?: string
}

/** Profile lookups. Each reads reactive state; a computed over toReactionUsers tracks profile loads. */
export interface ReactionUserResolvers {
  displayName: (userId: string) => string
  avatarUrl: (userId: string) => string
  color: (userId: string) => string
  handle?: (userId: string) => string | null
  bot?: (botId: string) => ReactionBotInfo | null
  /** Loads profiles and bots the lookups above read. */
  preload?: (actors: ReactionActor[]) => void
}

/** Pill identity within a message: emoji_id for a custom emoji, the emoji name otherwise. */
export function reactionGroupKey(group: Pick<ReactionGroup, 'emoji_id' | 'emoji'>): string {
  if (group.emoji_id) return group.emoji_id
  return group.emoji?.name || 'unknown'
}

/** Distinct Harmony profile ids among the actors; bridged Discord rows excluded. */
export function reactionProfileIds(actors: ReactionActor[] | undefined): string[] {
  const ids = new Set<string>()
  for (const actor of actors ?? []) {
    if (actor.user_id && !actor.metadata?.discord_user) ids.add(actor.user_id)
  }
  return [...ids]
}

/** `@username`, with `@domain` appended for a remote profile. */
export function formatUserHandle(
  user: { username?: string | null; domain?: string | null; isLocal?: boolean | null } | null | undefined,
): string | null {
  const username = user?.username?.trim()
  if (!username) return null
  if (user?.isLocal === false && user.domain) return `@${username}@${user.domain}`
  return `@${username}`
}

export function toReactionUser(actor: ReactionActor, resolvers: ReactionUserResolvers): ReactionUser {
  const discordUser = actor.metadata?.discord_user
  if (discordUser) {
    return {
      key: `discord:${discordUser.id}`,
      id: discordUser.id,
      kind: 'discord',
      displayName: discordUser.display_name || discordUser.username || 'Discord User',
      handle: discordUser.username ? `@${discordUser.username}` : null,
      avatarUrl: discordUser.avatar_url || '',
      userColor: BOT_NAME_COLOR,
      isBridged: true,
      bridgeSource: 'discord',
      discordUser,
    }
  }

  if (actor.bot_id && !actor.user_id) {
    const bot = resolvers.bot?.(actor.bot_id) ?? null
    const username = bot?.username || actor.username
    return {
      key: `bot:${actor.bot_id}`,
      id: actor.bot_id,
      kind: 'bot',
      displayName: bot?.displayName || actor.display_name || actor.username || `Bot-${actor.bot_id.slice(0, 8)}`,
      handle: username ? `@${username}` : null,
      avatarUrl: bot?.avatarUrl || actor.avatar_url || '/default_avatar.webp',
      userColor: BOT_NAME_COLOR,
      isBridged: false,
    }
  }

  const userId = actor.user_id ?? ''
  return {
    key: userId ? `user:${userId}` : `reaction:${actor.reaction_id}`,
    id: userId,
    kind: 'user',
    displayName: resolvers.displayName(userId),
    handle: userId ? resolvers.handle?.(userId) ?? null : null,
    avatarUrl: resolvers.avatarUrl(userId),
    userColor: resolvers.color(userId),
    isBridged: false,
  }
}

export function toReactionUsers(actors: ReactionActor[] | undefined, resolvers: ReactionUserResolvers): ReactionUser[] {
  return (actors ?? []).map(actor => toReactionUser(actor, resolvers))
}
