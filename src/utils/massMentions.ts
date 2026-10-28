/**
 * Typed @everyone and @here, as Discord's client reads them. Outside code and URLs they are the
 * server-wide mentions when the author holds MENTION_EVERYONE in the channel, and text otherwise;
 * neither names a user in any case. `@everyone@host` stays a user handle. Only the lowercase
 * words ping, as on Discord.
 */
import type { MessagePart } from '@/types'
import { HERE_ROLE_ID, hereMentionPart } from '@/utils/hereMention'

export const MASS_MENTION_WORDS: readonly string[] = ['everyone', HERE_ROLE_ID]

/** The author's right to ping in one channel, and that server's default role. */
export interface MassMentionOptions {
  allowed: boolean
  everyoneRole: { id: string; name: string; color: string | null } | null
}

/** `name` reads as @everyone or @here: any case, leading @ and surrounding space ignored. */
export function isMassMentionWord(name: unknown): boolean {
  if (typeof name !== 'string') return false
  return MASS_MENTION_WORDS.includes(name.trim().replace(/^@+/, '').trim().toLowerCase())
}

/** HANDLE_PATTERN (utils/mentionGrammar) restricted to the two words without a host. */
const TYPED_MASS_MENTION = /(?<![\p{L}\p{N}_@/])@(?:everyone|here)(?![\p{L}\p{N}_@-]|\.[\p{L}\p{N}_-])/u

export function hasTypedMassMention(text: string): boolean {
  return TYPED_MASS_MENTION.test(text)
}

/** The part a typed bare `@word` becomes: the mass mention when allowed, else the text. */
export function typedMassMentionPart(word: string, typed: string, options: MassMentionOptions | undefined): MessagePart {
  if (options?.allowed) {
    if (word === HERE_ROLE_ID) return hereMentionPart()
    if (word === 'everyone' && options.everyoneRole) {
      return {
        type: 'role_mention',
        roleId: options.everyoneRole.id,
        roleName: options.everyoneRole.name.replace(/^@/, ''),
        roleColor: options.everyoneRole.color,
      } as MessagePart
    }
  }
  return { type: 'text', text: typed }
}
