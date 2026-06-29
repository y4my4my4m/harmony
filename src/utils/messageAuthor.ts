import type { Message } from '@/types'

/** Message authored via an external bridge (Discord, etc.), not a native Harmony user row. */
export function isBridgedAuthorMessage(message: Message | null | undefined): boolean {
  return !!(message?.metadata?.discord_user || message?.metadata?.bridge_source)
}

export function getBridgeSource(message: Message | null | undefined): string | null {
  if (!isBridgedAuthorMessage(message)) return null
  return message?.metadata?.bridge_source ?? (message?.metadata?.discord_user ? 'discord' : null)
}

/** Profile UUID for DisplayName lookups; empty when author is bridged or bot-only. */
export function getHarmonyProfileUserId(message: Message | null | undefined): string {
  if (!message?.user_id || message.bot_id || isBridgedAuthorMessage(message)) return ''
  return message.user_id
}
