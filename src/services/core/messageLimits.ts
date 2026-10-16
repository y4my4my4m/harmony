/**
 * Soft message limits from instance_config, read through the instance settings store.
 *
 * The store loads every public key once and keeps it CACHE_DURATION; a send never waits on a
 * refresh, only on the first load. The limits are UX: enforce_message_length applies
 * max_message_length at the storage boundary and the CHECK constraint caps every row at
 * MESSAGE_TEXT_HARD_CEILING.
 */
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import {
  DEFAULT_MAX_MESSAGE_TEXT_LENGTH,
  MESSAGE_TEXT_HARD_CEILING,
} from '@/utils/messageContentUtils'

export const DEFAULT_MAX_MEDIA_ATTACHMENTS = 20

export interface MessageLimits {
  /** max_message_length clamped to [1, MESSAGE_TEXT_HARD_CEILING]. */
  maxLength: number
  /** max_media_attachments_per_post, at least 1. */
  maxMedia: number
}

/**
 * Clamped as enforce_message_length clamps it: 0 would disable the limit, and a value above
 * the ceiling is refused by the CHECK constraint with a less informative error.
 */
export function clampMessageLength(raw: unknown): number {
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? parseInt(raw, 10)
        : NaN
  const value = !Number.isNaN(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_MESSAGE_TEXT_LENGTH
  return Math.min(value, MESSAGE_TEXT_HARD_CEILING)
}

function attachmentLimit(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN
  return !Number.isNaN(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_MEDIA_ATTACHMENTS
}

/** Waits only for a store that never loaded; a stale one refreshes behind the answer. */
export async function messageLimits(): Promise<MessageLimits> {
  const store = useInstanceSettingsStore()
  if (!store.isLoaded) await store.fetchSettings()
  else if (!store.isCacheValid) void store.fetchSettings()
  return {
    maxLength: clampMessageLength(store.settings.maxMessageLength),
    maxMedia: attachmentLimit(store.settings.maxMediaAttachmentsPerPost),
  }
}
