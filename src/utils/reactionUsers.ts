import type { ReactionActor, ReactionGroup } from '@/types'
import { BOT_NAME_COLOR } from '@/utils/botUtils'
import { formatHandle } from '@/utils/handles'
import { getBridgedAuthor } from '@/utils/messageAuthor'

/** metadata.discord_user of a reaction bridged from Discord. */
export type DiscordReactionUser = NonNullable<NonNullable<ReactionActor['metadata']>['discord_user']>

/** One reactor in a reaction group: a Harmony user, a bot, or a bridged Discord user. */
export interface ReactionUser {
  /** Unique within one reaction group. */
  key: string
  /** Profile id, bot id, or Discord user snowflake, per `kind`. */
  id: string
  kind: 'user' | 'bot' | 'discord' | 'matrix'
  displayName: string
  /** `@username`, or `@username@domain` for a remote user. */
  handle: string | null
  avatarUrl: string
  userColor: string
  isBridged: boolean
  bridgeSource?: 'discord' | 'matrix'
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

/**
 * Pill identity within a message: emoji_id for a custom emoji, else the stored
 * custom_emoji_content. A bridged Discord pill names itself by its display name
 * (metadata.remote_emoji_name), which is no reaction a client can write.
 */
export function reactionGroupKey(group: Pick<ReactionGroup, 'emoji_id' | 'emoji'>): string {
  if (group.emoji_id) return group.emoji_id
  return reactionGroupContent(group) || 'unknown'
}

/** custom_emoji_content of a pill without an emojis row; its name when the content is absent. */
export function reactionGroupContent(group: Pick<ReactionGroup, 'emoji'>): string {
  const emoji = group.emoji as { content?: unknown; name?: unknown } | undefined
  if (typeof emoji?.content === 'string' && emoji.content) return emoji.content
  return typeof emoji?.name === 'string' ? emoji.name : ''
}

/** Distinct Harmony profile ids among the actors; bridged Discord rows excluded. */
export function reactionProfileIds(actors: ReactionActor[] | undefined): string[] {
  const ids = new Set<string>()
  for (const actor of actors ?? []) {
    if (actor.user_id && !getBridgedAuthor(actor)) ids.add(actor.user_id)
  }
  return [...ids]
}

/** `@username`, with `@domain` appended for a remote profile. */
export function formatUserHandle(
  user: { username?: string | null; domain?: string | null; isLocal?: boolean | null } | null | undefined,
): string | null {
  const username = user?.username?.trim()
  if (!username) return null
  return formatHandle({ username, domain: user?.domain, is_local: user?.isLocal })
}

export function toReactionUser(actor: ReactionActor, resolvers: ReactionUserResolvers): ReactionUser {
  const bridged = getBridgedAuthor(actor)
  if (bridged) {
    return {
      key: `${bridged.platform}:${bridged.id}`,
      id: bridged.id,
      kind: bridged.platform,
      displayName: bridged.display_name || bridged.username || (bridged.platform === 'matrix' ? 'Matrix User' : 'Discord User'),
      handle: bridged.platform === 'matrix' ? bridged.id : bridged.username ? `${bridged.username.startsWith('@') ? '' : '@'}${bridged.username}` : null,
      avatarUrl: bridged.avatar_url || '',
      userColor: BOT_NAME_COLOR,
      isBridged: true,
      bridgeSource: bridged.platform,
      discordUser: bridged.platform === 'discord' ? bridged : undefined,
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
