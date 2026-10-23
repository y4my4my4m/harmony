/**
 * Accounts that favourited or boosted a post, newest first. Mastodon's
 * /api/v1/statuses/:id/favourited_by and /reblogged_by: anyone who can see the
 * post reads its favourite and boost rows (RLS post_interactions_select_visible).
 * Inbound Likes and Announces are rows with remote profiles.
 */

import { supabase } from '@/supabase'
import { runtimeConfig } from '@/services/runtimeConfig'

export type ListedInteraction = 'favorite' | 'reblog'

export interface InteractionAccount {
  /** post_interactions.id */
  interactionId: string
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  /** "@user" here, "@user@domain" elsewhere. */
  handle: string
  /** UserProfile route param: "user" here, "user@domain" elsewhere. */
  routeHandle: string
}

export interface InteractionAccountsPage {
  accounts: InteractionAccount[]
  /** Offset of the next page: rows read, including any whose profile is unreadable. */
  nextOffset: number
  hasMore: boolean
}

export const INTERACTION_ACCOUNTS_PAGE = 40

const SELECT =
  'id, profile:profiles!post_interactions_user_id_fkey(id, username, display_name, avatar_url, domain, is_local)'

interface ProfileRow {
  id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  domain: string | null
  is_local: boolean | null
}

interface InteractionRow {
  id: string
  profile: ProfileRow | null
}

/** Misskey's "." domain placeholder counts as no domain. */
export function toInteractionAccount(interactionId: string, profile: ProfileRow): InteractionAccount {
  const username = profile.username || ''
  const domain = profile.domain && profile.domain !== '.' ? profile.domain : null
  const local = profile.is_local ?? (!domain || domain === runtimeConfig.domain)
  const routeHandle = local || !domain ? username : `${username}@${domain}`
  return {
    interactionId,
    id: profile.id,
    username,
    displayName: profile.display_name || username,
    avatarUrl: profile.avatar_url,
    handle: `@${routeHandle}`,
    routeHandle,
  }
}

/** One page from `offset`; one extra row is read to tell whether more exist. */
export async function fetchInteractionAccounts(
  postId: string,
  type: ListedInteraction,
  offset = 0,
  limit = INTERACTION_ACCOUNTS_PAGE,
): Promise<InteractionAccountsPage> {
  const { data, error } = await supabase
    .from('post_interactions')
    .select(SELECT)
    .eq('post_id', postId)
    .eq('interaction_type', type)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit)
  if (error) throw error

  const rows = ((data ?? []) as unknown as InteractionRow[]).slice(0, limit + 1)
  const page = rows.slice(0, limit)
  return {
    accounts: page
      .filter((row): row is InteractionRow & { profile: ProfileRow } => !!row.profile)
      .map((row) => toInteractionAccount(row.id, row.profile)),
    nextOffset: offset + page.length,
    hasMore: rows.length > limit,
  }
}
