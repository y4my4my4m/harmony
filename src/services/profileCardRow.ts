/**
 * The profiles row a profile card shows: post and follow counters, a remote account's origin
 * totals, activity counters, join date and follow approval. One read per card open.
 *
 * The last row read per account stays in memory, so a reopened card shows its figures at once
 * while that open's read runs.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { REMOTE_COUNT_COLUMNS, type ProfileCountSource } from '@/utils/profileCounts'

export interface ProfileCardRow extends ProfileCountSource {
  created_at?: string | null
  /** Denormalized counters, migration 20260524_bot_grants_and_activity_counters.sql. */
  message_count?: number | null
  /** Minutes. */
  voice_minutes?: number | null
  manually_approves_followers?: boolean | null
}

const CARD_COLUMNS = [
  'is_local',
  'created_at',
  'posts_count',
  'followers_count',
  'following_count',
  ...REMOTE_COUNT_COLUMNS,
  'message_count',
  'voice_minutes',
  'manually_approves_followers',
].join(', ')

const KEPT_ROWS = 200

// Insertion order is recency order: the first key is the oldest.
const lastRows = new Map<string, ProfileCardRow>()

export function knownProfileCardRow(profileId: string): ProfileCardRow | null {
  return lastRows.get(profileId) ?? null
}

function remember(profileId: string, row: ProfileCardRow): void {
  lastRows.delete(profileId)
  lastRows.set(profileId, row)
  if (lastRows.size > KEPT_ROWS) lastRows.delete(lastRows.keys().next().value as string)
}

/** Merges `fields` into the remembered row of `profileId`; no-op when none is remembered. */
export function updateKnownProfileCardRow(profileId: string, fields: ProfileCardRow): void {
  const known = lastRows.get(profileId)
  if (known) remember(profileId, { ...known, ...fields })
}

/** The row of `profileId`; null when it is absent or the read fails. */
export async function readProfileCardRow(profileId: string): Promise<ProfileCardRow | null> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(CARD_COLUMNS)
      .eq('id', profileId)
      .maybeSingle()
    if (error) {
      debug.error('Profile card row read failed:', error.code, error.message)
      return null
    }
    if (!data) return null
    const row = data as ProfileCardRow
    remember(profileId, row)
    return row
  } catch (err) {
    debug.error('Profile card row read failed:', err)
    return null
  }
}
