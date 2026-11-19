// Short spoken forms of chat messages, for live announcements. Spoilers and
// encrypted bodies are never spoken; attachments are named by kind and their
// description.

import type { MessagePart } from '@/types'
import { customEmojiLabel } from './emojiNames'
import { urlPartPlainText } from '@/utils/maskedLinks'
import { withoutStickerFallbacks } from '@/utils/stickerParts'
import { isMassMentionWord } from '@/utils/massMentions'

export type Translate = (key: string, params?: Record<string, unknown>, plural?: number) => string

/** Characters of message text kept in an announcement. */
export const SPOKEN_TEXT_MAX = 160

const SPOILER = /\|\|(?=\S)[\s\S]*?\S\|\|/g

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

/** The message as one line of speech; '' when nothing speakable remains. */
export function messageSpeechText(
  parts: MessagePart[] | null | undefined,
  t: Translate,
  options: { encrypted?: boolean; max?: number } = {},
): string {
  if (options.encrypted) return t('messageA11y.speech.encrypted')
  if (!Array.isArray(parts)) return ''
  const pieces: string[] = []
  for (const part of withoutStickerFallbacks(parts)) {
    if (!part || typeof part !== 'object') continue
    const p = part as MessagePart & Record<string, any>
    switch (p.type) {
      case 'text':
        if (p.text) pieces.push(String(p.text).replace(SPOILER, ` ${t('messageA11y.speech.spoiler')} `))
        break
      case 'emoji':
        pieces.push(customEmojiLabel(p.emoji?.name))
        break
      case 'mention':
        // A user named everyone or here is read with the host, unlike the mass mention.
        pieces.push(isMassMentionWord(p.username) && p.domain ? `@${p.username}@${p.domain}` : `@${p.username ?? ''}`)
        break
      case 'role_mention':
        // Read as a role: a member of the same name is read as @name alone.
        pieces.push(t('mentionLabels.rolePill', { name: String(p.roleName ?? '').replace(/^@/, '') }))
        break
      case 'channel_mention':
        pieces.push(`#${p.name ?? ''}`)
        break
      case 'hashtag':
        pieces.push(`#${p.name ?? ''}`)
        break
      case 'url':
        pieces.push(typeof p.url === 'string' ? urlPartPlainText({ ...p, url: p.url }) : '')
        break
      case 'file': {
        const alt = typeof p.altText === 'string' ? p.altText.trim() : ''
        if (p.fileType === 'image') pieces.push(alt ? t('messageA11y.speech.imageWithAlt', { alt }) : t('messageA11y.speech.image'))
        else if (p.fileType === 'video') pieces.push(alt ? t('messageA11y.speech.videoWithAlt', { alt }) : t('messageA11y.speech.video'))
        else if (p.fileType === 'audio') pieces.push(t('messageA11y.speech.audio'))
        else pieces.push(t('messageA11y.speech.file', { name: p.fileName ?? '' }))
        break
      }
      case 'poll':
        pieces.push(t('messageA11y.speech.poll', { question: p.question ?? '' }))
        break
      case 'sticker':
        pieces.push(t('messageA11y.speech.sticker', { name: p.name ?? '', description: p.description ?? '' }))
        break
    }
  }
  const text = pieces.join(' ').replace(/\s+/g, ' ').trim()
  return truncate(text, options.max ?? SPOKEN_TEXT_MAX)
}

export interface SpeechIntroduction {
  /** Plain displayed name of the message's author. */
  author?: string | null
  /** Displayed name of the author the message replies to; undefined when it is
      not a reply, '' when that author cannot be read. */
  replyAuthor?: string | null
}

/**
 * Spoken introduction of an explicitly spoken message: "Alice said:",
 * "Alice replied to Bob:" and, when the original's author cannot be read,
 * "Alice replied:" so no id or invented name is spoken. An unknown author
 * reads as the existing Someone fallback.
 */
export function messageSpeechIntroduction(intro: SpeechIntroduction, t: Translate): string {
  const author = intro.author?.trim() || t('systemEvents.someone')
  if (intro.replyAuthor === undefined) return t('messageA11y.speech.said', { author })
  const replyAuthor = intro.replyAuthor?.trim()
  return replyAuthor
    ? t('messageA11y.speech.repliedTo', { author, replyAuthor })
    : t('messageA11y.speech.replied', { author })
}

const SYSTEM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function systemProfileId(value: unknown): string | null {
  return typeof value === 'string' && SYSTEM_UUID.test(value) ? value : null
}

/** People a system notice names by id; a name that cannot be resolved reads as "Someone". */
export interface SystemEventSpeechNames {
  user?: (userId: string) => string | null | undefined
  bot?: (botId: string) => string | null | undefined
}

export interface SystemEventSpeechOptions {
  names?: SystemEventSpeechNames
  /** The viewer, so an unanswered call the viewer started is announced as missed. */
  currentUserId?: string | null
}

const SYSTEM_ENCRYPTION_KEYS: Record<string, string> = {
  channel_encryption_enabled: 'systemEvents.encryptionEnabled',
  channel_encryption_disabled: 'systemEvents.encryptionDisabled',
  channel_voice_encryption_enabled: 'systemEvents.voiceEncryptionEnabled',
  channel_voice_encryption_disabled: 'systemEvents.voiceEncryptionDisabled',
}

/** A call's length as the row shows it: 45s, 3m 5s, 1h 2m. */
function spokenDuration(value: unknown, t: Translate): string {
  const seconds = Math.max(0, Math.floor(Number(value) || 0))
  if (seconds < 60) return t('systemEvents.duration.seconds', { s: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const s = seconds % 60
    return s > 0 ? t('systemEvents.duration.minutesSeconds', { m: minutes, s }) : t('systemEvents.duration.minutes', { m: minutes })
  }
  const hours = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? t('systemEvents.duration.hoursMinutes', { h: hours, m }) : t('systemEvents.duration.hours', { h: hours })
}

/**
 * Spoken text of a system notice (messages.is_system), built from the same metadata and
 * `systemEvents` wording the row renders. '' for a type without a sentence, so the caller
 * reads the stored content instead. The people are metadata ids resolved through
 * `options.names`; ids, link targets and the row's author are never spoken.
 */
export function systemEventSpeechText(
  metadata: unknown,
  t: Translate,
  options: SystemEventSpeechOptions = {},
): string {
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, any>) : {}
  const type = typeof meta.type === 'string' ? meta.type : ''
  const someone = t('systemEvents.someone')

  const personName = (value: unknown): string => {
    const id = systemProfileId(value)
    return (id && options.names?.user?.(id)?.trim()) || someone
  }
  const actorName = (): string => {
    if (systemProfileId(meta.actor_id)) return personName(meta.actor_id)
    const discord = meta.discord_user
    const discordName = discord?.display_name || discord?.username
    if (typeof discordName === 'string' && discordName) return discordName
    const botId = systemProfileId(meta.actor_bot_id)
    if (botId) return options.names?.bot?.(botId)?.trim() || someone
    if (typeof meta.actor_name === 'string' && meta.actor_name.trim()) return meta.actor_name.trim()
    return someone
  }

  const memberIds = Array.isArray(meta.user_ids)
    ? meta.user_ids.filter((id: unknown): id is string => !!systemProfileId(id))
    : []
  const participants = Array.isArray(meta.participants) ? meta.participants : []
  const missedCall = type === 'call_ended' && participants.length < 2
  const actorId = systemProfileId(meta.actor_id)
  const missedByMe = missedCall && actorId !== (options.currentUserId ?? undefined)
  const callType = meta.call_type === 'video' ? 'video' : 'voice'
  const subject = () => personName(meta.subject_id)

  let key: string | null = null
  let params: Record<string, unknown> = {}
  let plural: number | undefined
  switch (type) {
    case 'member_join':
      key = 'systemEvents.memberJoin'
      params = { subject: subject() }
      break
    case 'member_leave':
      key = 'systemEvents.memberLeave'
      params = { subject: subject() }
      break
    case 'member_kick':
    case 'member_ban': {
      const kick = type === 'member_kick'
      if (actorId) {
        key = kick ? 'systemEvents.memberKick' : 'systemEvents.memberBan'
        params = { actor: actorName(), subject: subject() }
      } else {
        key = kick ? 'systemEvents.memberKickNoActor' : 'systemEvents.memberBanNoActor'
        params = { subject: subject() }
      }
      break
    }
    case 'thread_created':
      if (systemProfileId(meta.thread_id)) {
        key = 'systemEvents.threadCreated'
        params = {
          actor: actorName(),
          thread: typeof meta.thread_name === 'string' && meta.thread_name ? meta.thread_name : t('systemEvents.threadFallbackName'),
          allThreads: t('systemEvents.allThreads'),
        }
      } else {
        key = 'systemEvents.threadCreatedNoLink'
        params = { actor: actorName() }
      }
      break
    case 'group_created':
      if (meta.event === 'members_added' && memberIds.length > 0) {
        key = 'systemEvents.membersAdded'
        params = { actor: actorName(), members: memberIds.map(personName).join(t('systemEvents.listSeparator')) }
      } else if (Number(meta.participant_count) > 0) {
        key = 'systemEvents.groupCreatedWith'
        plural = Number(meta.participant_count)
        params = { actor: actorName(), count: plural }
      } else {
        key = 'systemEvents.groupCreated'
        params = { actor: actorName() }
      }
      break
    case 'call_started':
      key = `systemEvents.callStarted.${callType}`
      params = { actor: actorName() }
      break
    case 'call_ended':
      if (missedByMe) {
        key = `systemEvents.callMissed.${callType}`
        params = { actor: actorName() }
      } else if (missedCall) {
        key = `systemEvents.callStarted.${callType}`
        params = { actor: actorName() }
      } else {
        key = `systemEvents.callEnded.${callType}`
        params = { actor: actorName(), duration: spokenDuration(meta.duration_seconds, t) }
      }
      break
    default:
      if (SYSTEM_ENCRYPTION_KEYS[type]) {
        key = SYSTEM_ENCRYPTION_KEYS[type]
        params = { actor: actorName() }
      }
  }
  if (!key) return ''

  let text = t(key, params, plural)
  if ((type === 'member_kick' || type === 'member_ban') && typeof meta.reason === 'string' && meta.reason.trim()) {
    text += ` ${t('systemEvents.reason', { reason: meta.reason.trim() })}`
  }
  if (missedCall && !missedByMe) text += ` ${t('systemEvents.noAnswer')}`
  return text
}

export interface IncomingMessage {
  authorName: string
  text: string
}

/** Names listed in a burst summary before "N others". */
const NAMES_LISTED = 3

/**
 * One announcement for a burst of incoming messages: "Alice: hi" for one,
 * "3 new messages from Alice, Bob" for several.
 */
export function summarizeIncoming(items: IncomingMessage[], t: Translate): string {
  if (items.length === 0) return ''
  if (items.length === 1) {
    const { authorName, text } = items[0]
    return text
      ? t('messageA11y.announce.one', { name: authorName, text })
      : t('messageA11y.announce.oneEmpty', { name: authorName })
  }
  const names = [...new Set(items.map((item) => item.authorName).filter(Boolean))]
  const listed = names.slice(0, NAMES_LISTED).join(', ')
  const rest = names.length - NAMES_LISTED
  const from = rest > 0 ? t('messageA11y.announce.andOthers', { names: listed, count: rest }, rest) : listed
  return t('messageA11y.announce.many', { count: items.length, names: from }, items.length)
}
