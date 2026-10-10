/**
 * account-moved jobs, queued by public.apply_account_move() (migration
 * 20261010900001_account_migration.sql) with { migration_id }, for a local move and for a
 * Move received from another instance.
 *
 * 1. A local origin still pointing at the migration's target sends Move{actor, object:
 *    actor, target} to the inbox of every remote follower and of every instance it shares a
 *    server with, signed by the origin. A received Move is not forwarded.
 * 2. The origin's local followers move to the target in batches (migrate_account_followers).
 * 3. delivered_at marks the migration done. The sweep re-queues one still undelivered after
 *    five minutes; a retried job sends the Move again, which receivers take as a repeat.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { buildMoveActivity, localActorUri, migrateLocalFollowers } from '../../activitypub/accountMigration.js';
import { getServerCoMemberInstances } from '../../utils/federationUtils.js';
import { logger } from '../../utils/logger.js';

export interface AccountMovedJobData {
  migration_id: string;
}

/** Inboxes a local origin's Move goes to: remote followers, then co-member instances. */
export async function moveRecipientInboxes(profileId: string): Promise<string[]> {
  const inboxes = new Set(await DeliveryQueue.followerInboxes(profileId));
  for (const group of await getServerCoMemberInstances(profileId)) {
    inboxes.add(group.shared_inbox || `https://${group.instance}/inbox`);
  }
  return [...inboxes];
}

export async function handleAccountMovedJob(data: AccountMovedJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const migrationId = data?.migration_id;
  if (typeof migrationId !== 'string' || !migrationId) {
    logger.warn('account-moved job without migration_id, dropped');
    return;
  }

  const { data: migration, error } = await supabase
    .from('account_migrations')
    .select('id, profile_id, target_profile_id, target_uri, delivered_at, cancelled_at')
    .eq('id', migrationId)
    .maybeSingle();
  if (error) throw error;
  if (!migration || migration.delivered_at || migration.cancelled_at) return;

  const { data: origin, error: originError } = await supabase
    .from('profiles')
    .select('id, username, is_local, deleted_at, moved_to_uri')
    .eq('id', migration.profile_id)
    .maybeSingle();
  if (originError) throw originError;
  if (!origin) return;

  if (origin.is_local && !origin.deleted_at && origin.moved_to_uri === migration.target_uri) {
    const move = buildMoveActivity(localActorUri(origin.username), migration.target_uri, migration.id);
    const inboxes = await moveRecipientInboxes(origin.id);
    await DeliveryQueue.deliverEach(inboxes.map((inbox) => ({ inbox, activity: move })), origin.id);
    logger.info(`Move of ${origin.username} to ${migration.target_uri} sent to ${inboxes.length} inbox(es)`);
  }

  const moved = await migrateLocalFollowers(supabase, migration.id);
  logger.info(`Migration ${migration.id}: ${moved} local follower(s) moved to ${migration.target_uri}`);

  const { error: doneError } = await supabase
    .from('account_migrations')
    .update({ delivered_at: new Date().toISOString() })
    .eq('id', migration.id);
  if (doneError) throw doneError;
}
