/**
 * Account migration (migration 20261010900001_account_migration.sql).
 *
 * The Move activity in the shape Mastodon's MoveSerializer sends, the alsoKnownAs and
 * movedTo columns every remote profile write carries, and the batched follower migration
 * the 'account-moved' job runs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import config from '../config/index.js';
import { sameOrigin } from '../utils/apOrigin.js';

/** A second Move of the same origin inside this window is refused (begin_account_move, record_remote_account_move). */
export const MOVE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Followers per migrate_account_followers call. */
export const FOLLOWER_BATCH = 200;

/** Move{actor: origin, object: origin, target}. The id is unique per migration. */
export function buildMoveActivity(originUri: string, targetUri: string, migrationId: string): Record<string, unknown> {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${originUri}#moves/${migrationId}`,
    type: 'Move',
    actor: originUri,
    object: originUri,
    target: targetUri,
  };
}

/** URI of an activity's object or target, given as a string or an object with an id. */
export function activityReference(value: unknown): string | null {
  const id = typeof value === 'string' ? value : (value as any)?.id;
  return typeof id === 'string' && id ? id : null;
}

/** Actor URI of a local account on this instance. */
export function localActorUri(username: string): string {
  return `https://${config.INSTANCE_DOMAIN}/users/${username}`;
}

/**
 * Stored profile with this actor URI. A local account whose federated_id was never
 * backfilled is found by its /users/<username> path.
 */
export async function profileIdByActorUri(supabase: SupabaseClient, uri: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('federated_id', uri)
    .maybeSingle();
  if (data?.id) return data.id;

  if (!sameOrigin(uri, `https://${config.INSTANCE_DOMAIN}/`)) return null;
  const username = new URL(uri).pathname.match(/^\/users\/([A-Za-z0-9_]+)$/)?.[1];
  if (!username) return null;
  const { data: local } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .eq('is_local', true)
    .is('deleted_at', null)
    .maybeSingle();
  return local?.id ?? null;
}

/**
 * Columns of a remote profile write for the actor's alsoKnownAs and movedTo.
 * moved_to_id names the stored profile of movedTo when there is one; moved_at is stamped
 * when movedTo changes to a new target and cleared with it.
 */
export async function movedColumns(
  supabase: SupabaseClient,
  parsed: { also_known_as: string[]; moved_to_uri: string | null },
  previous: { id?: string | null; moved_to_uri?: string | null } | null | undefined,
): Promise<Record<string, unknown>> {
  const columns: Record<string, unknown> = {
    also_known_as: parsed.also_known_as,
    moved_to_uri: parsed.moved_to_uri,
  };
  if (!parsed.moved_to_uri) {
    columns.moved_to_id = null;
    columns.moved_at = null;
    return columns;
  }
  const targetId = await profileIdByActorUri(supabase, parsed.moved_to_uri);
  columns.moved_to_id = targetId && targetId !== previous?.id ? targetId : null;
  if (parsed.moved_to_uri !== previous?.moved_to_uri) {
    columns.moved_at = new Date().toISOString();
  }
  return columns;
}

/** Runs migrate_account_followers until a batch comes back short; returns the followers moved. */
export async function migrateLocalFollowers(supabase: SupabaseClient, migrationId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const { data, error } = await supabase.rpc('migrate_account_followers', {
      p_migration_id: migrationId,
      p_limit: FOLLOWER_BATCH,
    });
    if (error) throw new Error(`migrate_account_followers ${migrationId}: ${error.message}`);
    const moved = typeof data === 'number' ? data : 0;
    total += moved;
    if (moved < FOLLOWER_BATCH) return total;
  }
}
