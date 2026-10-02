/**
 * Local actors whose accounts were deleted (public.deleted_actors, migration
 * 20261005400001_account_security.sql).
 *
 * delete_my_account() keeps the actor URI, the signing key and the inboxes of remote
 * followers and followees, then tombstones the profile. The Delete is sent under the
 * original keyId so remote servers verify it against the key they cached; the old handle
 * answers 410 Gone with a Tombstone, as Mastodon does.
 */

import { getSupabaseClient } from '../config/supabase.js';

export interface DeletedActor {
  profile_id: string;
  username: string;
  domain: string;
  actor_uri: string;
  private_key: string | null;
  inboxes: string[];
  deleted_at: string;
  delivered_at: string | null;
}

const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** Delete{actor} in the shape Mastodon sends for a removed account. */
export function buildActorDelete(actorUri: string): Record<string, unknown> {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUri}#delete`,
    type: 'Delete',
    actor: actorUri,
    to: [AS_PUBLIC],
    object: actorUri,
  };
}

export function actorTombstone(actorUri: string, deletedAt: string | null | undefined): Record<string, unknown> {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: actorUri,
    type: 'Tombstone',
    formerType: 'Person',
    ...(deletedAt ? { deleted: deletedAt } : {}),
  };
}

export async function deletedActorByProfile(profileId: string): Promise<DeletedActor | null> {
  const { data, error } = await getSupabaseClient()
    .from('deleted_actors')
    .select('profile_id, username, domain, actor_uri, private_key, inboxes, deleted_at, delivered_at')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw error;
  return (data as DeletedActor | null) ?? null;
}

/**
 * Most recent deletion of a local handle. The username may since belong to a new
 * account; callers look up live profiles first.
 */
export async function deletedActorByUsername(username: string): Promise<Pick<DeletedActor, 'actor_uri' | 'deleted_at'> | null> {
  const { data, error } = await getSupabaseClient()
    .from('deleted_actors')
    .select('actor_uri, deleted_at')
    .ilike('username', username.replace(/[\\%_]/g, (c) => `\\${c}`))
    .order('deleted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data ?? null;
}
