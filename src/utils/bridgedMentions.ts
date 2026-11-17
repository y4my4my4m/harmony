import type { BridgePlatform } from '@/types'
import { isMatrixMention, parseMatrixId } from '@/utils/matrixMentions'
import { bridgePlatformLabel } from '@/utils/messageAuthor'

/** The fields of a mention part these helpers read; parts from storage are untyped. */
export interface BridgedMentionLike {
  userId?: unknown
  username?: unknown
  displayName?: unknown
  domain?: unknown
  isBridged?: unknown
  bridgeSource?: unknown
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Platform of a bridged mention part; null for a Harmony or fediverse mention. */
export function bridgedMentionPlatform(part: BridgedMentionLike | null | undefined): BridgePlatform | null {
  if (!part) return null
  if (isMatrixMention(part)) return 'matrix'
  if (part.bridgeSource === 'discord' || part.domain === 'discord.com' || part.isBridged === true) return 'discord'
  return null
}

/** Shown name: Discord the username; Matrix the display name, else the MXID localpart. */
export function bridgedMentionName(part: BridgedMentionLike, platform: BridgePlatform): string {
  if (platform === 'matrix') {
    return str(part.displayName) || parseMatrixId(part.userId)?.username || str(part.username) || str(part.userId)
  }
  return str(part.username).replace(/^@+/, '') || str(part.displayName)
}

/** Handle: Discord `@username`, Matrix the MXID. */
export function bridgedMentionHandle(part: BridgedMentionLike, platform: BridgePlatform): string {
  if (platform === 'matrix') return str(part.userId)
  const username = str(part.username).replace(/^@+/, '')
  return username ? `@${username}` : ''
}

/** Tooltip of a bridged mention: `Platform: @name`, as a bridged member row's. */
export function bridgedMentionTitle(part: BridgedMentionLike, platform: BridgePlatform): string {
  return `${bridgePlatformLabel(platform)}: @${bridgedMentionName(part, platform)}`
}

/** `@name` of a bridged mention in plain text; null for any other mention. */
export function bridgedMentionPlainText(part: BridgedMentionLike | null | undefined): string | null {
  const platform = bridgedMentionPlatform(part)
  return platform ? `@${bridgedMentionName(part!, platform)}` : null
}
