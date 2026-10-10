/**
 * Accounts named by actor URI: aliases (profiles.also_known_as) and move targets
 * (profiles.moved_to_id / moved_to_uri, migration 20261010900001_account_migration.sql).
 */

import { supabase } from '@/supabase'
import { runtimeConfig } from '@/services/runtimeConfig'

export interface AccountRef {
  id: string | null
  uri: string | null
  /** @user for an account here, @user@host otherwise. */
  handle: string
  /** UserProfile route param; null when the account has no handle to route by. */
  routeHandle: string | null
  displayName: string | null
  avatarUrl: string | null
  isLocal: boolean
}

interface ProfileRow {
  id: string
  username: string | null
  domain: string | null
  is_local: boolean | null
  display_name: string | null
  avatar_url: string | null
  federated_id: string | null
}

const PROFILE_COLUMNS = 'id, username, domain, is_local, display_name, avatar_url, federated_id'

/** user@host from an actor URI of the /users/<name> or /@<name> forms Mastodon, Misskey and GoToSocial serve. */
export function handleFromActorUri(uri: string): { username: string; domain: string } | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const name = url.pathname.match(/^\/users\/([^/]+)\/?$/)?.[1] ?? url.pathname.match(/^\/@([^/]+)\/?$/)?.[1]
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) return null
    return { username: name, domain: url.host.toLowerCase() }
  } catch {
    return null
  }
}

function isLocalDomain(domain: string | null | undefined): boolean {
  const own = (runtimeConfig.domain as string | undefined)?.toLowerCase()
  return !!domain && !!own && domain.toLowerCase() === own
}

export function accountRefFromProfile(row: ProfileRow): AccountRef {
  const local = row.is_local === true || isLocalDomain(row.domain)
  const username = row.username ?? ''
  return {
    id: row.id,
    uri: row.federated_id,
    handle: local || !row.domain ? `@${username}` : `@${username}@${row.domain}`,
    routeHandle: username ? (local || !row.domain ? username : `${username}@${row.domain}`) : null,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isLocal: local,
  }
}

/** An account known only by its URI. */
export function accountRefFromUri(uri: string): AccountRef {
  const parsed = handleFromActorUri(uri)
  const local = !!parsed && isLocalDomain(parsed.domain)
  return {
    id: null,
    uri,
    handle: parsed ? (local ? `@${parsed.username}` : `@${parsed.username}@${parsed.domain}`) : uri,
    routeHandle: parsed ? (local ? parsed.username : `${parsed.username}@${parsed.domain}`) : null,
    displayName: null,
    avatarUrl: null,
    isLocal: local,
  }
}

/** Stored accounts for actor URIs, in the order given; URIs with no stored profile stand alone. */
export async function accountRefsForUris(uris: string[]): Promise<AccountRef[]> {
  if (uris.length === 0) return []
  const { data } = await supabase.from('profiles').select(PROFILE_COLUMNS).in('federated_id', uris)
  const byUri = new Map<string, ProfileRow>()
  for (const row of (data ?? []) as ProfileRow[]) {
    if (row.federated_id) byUri.set(row.federated_id, row)
  }
  return uris.map((uri) => {
    const row = byUri.get(uri)
    return row ? accountRefFromProfile(row) : accountRefFromUri(uri)
  })
}

/** The account a profile moved to, by id when stored and by URI otherwise. */
export async function resolveMoveTarget(movedToId: string | null | undefined, movedToUri: string | null | undefined): Promise<AccountRef | null> {
  if (movedToId) {
    const { data } = await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', movedToId).maybeSingle()
    if (data) return accountRefFromProfile(data as ProfileRow)
  }
  if (movedToUri) {
    const [ref] = await accountRefsForUris([movedToUri])
    return ref ?? null
  }
  return null
}
