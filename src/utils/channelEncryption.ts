/**
 * Per-channel encryption: floor resolution and the wire shape of encrypted channel content.
 *
 * resolveChannelEncryption mirrors public.channel_messages_encrypted() and the voice branch of
 * public.effective_channel_encryption() in
 * db_schema/migrations/20261001000001_channel_encryption_settings.sql. The database is
 * authoritative; this copy renders the channel list from table rows and broadcasts.
 *
 * Encrypted channel content is [ciphertext text part, ...plaintext mention parts]. The server
 * reads the mention parts for notifications. Clients render mentions only from the decrypted
 * payload and never from the parts beside the ciphertext.
 */
import type { MessagePart } from '@/types'
import { HERE_ROLE_ID } from '@/utils/hereMention'

export type ServerEncryptionMode = 'disabled' | 'optional' | 'required' | 'required_local_only'
export type VoiceEncryptionMode = 'disabled' | 'required'
export type HistoryVisibility = 'joined' | 'shared'

export interface ServerEncryptionPolicy {
  encryption_mode?: string | null
  voice_encryption_mode?: string | null
}

export interface ChannelEncryptionRow {
  channel_id: string
  messages_encrypted: boolean
  voice_encrypted: boolean
  history_visibility?: string | null
  enabled_at?: string | null
  enabled_by?: string | null
}

export interface ResolvedChannelEncryption {
  serverMode: ServerEncryptionMode
  voiceMode: VoiceEncryptionMode
  messagesEncrypted: boolean
  voiceEncrypted: boolean
  /** The server floor fixes messagesEncrypted. */
  messagesLocked: boolean
  /** The server floor fixes voiceEncrypted. */
  voiceLocked: boolean
  historyVisibility: HistoryVisibility
}

export interface EffectiveChannelEncryption extends ResolvedChannelEncryption {
  channelId: string
  serverId: string | null
  enabledAt: string | null
  enabledBy: string | null
  /** Active non-bridge bot installs in the server. */
  botCount: number
  /** Active bridge installs, or 1 for a Discord bridge pairing. */
  bridgeCount: number
}

const SERVER_MODES: readonly ServerEncryptionMode[] = ['disabled', 'optional', 'required', 'required_local_only']

export function normalizeServerMode(mode: unknown): ServerEncryptionMode {
  return SERVER_MODES.includes(mode as ServerEncryptionMode) ? (mode as ServerEncryptionMode) : 'disabled'
}

export function normalizeVoiceMode(mode: unknown): VoiceEncryptionMode {
  return mode === 'required' ? 'required' : 'disabled'
}

export function isRequiredMode(mode: ServerEncryptionMode): boolean {
  return mode === 'required' || mode === 'required_local_only'
}

/** A missing policy row is 'disabled'; a missing channel row is off. */
export function resolveChannelEncryption(
  policy: ServerEncryptionPolicy | null | undefined,
  row: Pick<ChannelEncryptionRow, 'messages_encrypted' | 'voice_encrypted' | 'history_visibility'> | null | undefined,
): ResolvedChannelEncryption {
  const serverMode = normalizeServerMode(policy?.encryption_mode)
  const voiceMode = normalizeVoiceMode(policy?.voice_encryption_mode)

  const messagesEncrypted = isRequiredMode(serverMode)
    || (serverMode === 'optional' && row?.messages_encrypted === true)
  const voiceEncrypted = voiceMode === 'required'
    || (serverMode !== 'disabled' && row?.voice_encrypted === true)

  return {
    serverMode,
    voiceMode,
    messagesEncrypted,
    voiceEncrypted,
    messagesLocked: serverMode !== 'optional',
    voiceLocked: voiceMode === 'required' || serverMode === 'disabled',
    historyVisibility: row?.history_visibility === 'shared' ? 'shared' : 'joined',
  }
}

/** Parses the jsonb returned by effective_channel_encryption / set_channel_encryption. */
export function parseEffectiveChannelEncryption(raw: unknown): EffectiveChannelEncryption | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.channel_id !== 'string') return null
  const serverMode = normalizeServerMode(r.server_mode)
  const voiceMode = normalizeVoiceMode(r.voice_mode)
  return {
    channelId: r.channel_id,
    serverId: typeof r.server_id === 'string' ? r.server_id : null,
    serverMode,
    voiceMode,
    messagesEncrypted: r.messages_encrypted === true,
    voiceEncrypted: r.voice_encrypted === true,
    messagesLocked: r.messages_locked === true,
    voiceLocked: r.voice_locked === true,
    historyVisibility: r.history_visibility === 'shared' ? 'shared' : 'joined',
    enabledAt: typeof r.enabled_at === 'string' ? r.enabled_at : null,
    enabledBy: typeof r.enabled_by === 'string' ? r.enabled_by : null,
    botCount: typeof r.bot_count === 'number' ? r.bot_count : 0,
    bridgeCount: typeof r.bridge_count === 'number' ? r.bridge_count : 0,
  }
}

// public.is_plaintext_mention_part() limits.
const MAX_PLAINTEXT_MENTIONS = 100
const MAX_USERNAME = 100
const MAX_USER_ID = 64
const MAX_DOMAIN = 253
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PlaintextMentionPart =
  | { type: 'mention'; userId?: string; username: string; domain?: string | null; isLocal?: boolean }
  | { type: 'role_mention'; roleId: string }

/**
 * The mention parts of a plaintext payload, reduced to the keys the server accepts beside
 * ciphertext. Display names, role names and colours stay inside the ciphertext. Duplicates and
 * parts outside the server limits are dropped.
 */
export function extractPlaintextMentionParts(content: readonly MessagePart[] | null | undefined): PlaintextMentionPart[] {
  if (!Array.isArray(content)) return []
  const out: PlaintextMentionPart[] = []
  const seen = new Set<string>()

  for (const part of content as any[]) {
    if (out.length >= MAX_PLAINTEXT_MENTIONS) break
    if (!part || typeof part !== 'object') continue

    if (part.type === 'mention') {
      const username = typeof part.username === 'string' ? part.username : ''
      if (!username || username.length > MAX_USERNAME) continue
      const mention: PlaintextMentionPart = { type: 'mention', username }
      if (typeof part.userId === 'string' && part.userId && part.userId.length <= MAX_USER_ID) {
        mention.userId = part.userId
      }
      if (typeof part.domain === 'string' && part.domain.length <= MAX_DOMAIN) {
        mention.domain = part.domain
      }
      if (typeof part.isLocal === 'boolean') mention.isLocal = part.isLocal
      const key = `m:${mention.userId ?? ''}:${username}:${mention.domain ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(mention)
    } else if (part.type === 'role_mention') {
      if (typeof part.roleId !== 'string' || !(UUID_RE.test(part.roleId) || part.roleId === HERE_ROLE_ID)) continue
      const key = `r:${part.roleId.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ type: 'role_mention', roleId: part.roleId })
    }
  }
  return out
}

/** The stored content of an encrypted channel message: ciphertext first, then mention parts. */
export function withPlaintextMentions(
  encryptedContent: readonly MessagePart[],
  plaintextContent: readonly MessagePart[],
): MessagePart[] {
  const ciphertext = encryptedContent[0]
  if (!ciphertext) throw new Error('Encrypted content has no ciphertext part')
  return [ciphertext, ...(extractPlaintextMentionParts(plaintextContent) as unknown as MessagePart[])]
}

/**
 * The parts to render for a message that is still encrypted: the ciphertext part alone. The
 * plaintext mention parts beside it are server metadata and are never displayed.
 */
export function undecryptedDisplayParts(content: readonly MessagePart[] | null | undefined): MessagePart[] {
  if (!Array.isArray(content) || content.length === 0) return []
  const first = content[0] as any
  return first && typeof first === 'object' && first.type === 'text' ? [first as MessagePart] : []
}

/** True for a message whose payload is still ciphertext on this client. */
export function isUndecrypted(message: { encrypted?: boolean | null; decrypted?: boolean | null } | null | undefined): boolean {
  return message?.encrypted === true && message.decrypted !== true
}
