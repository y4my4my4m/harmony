/**
 * account-deleted jobs, queued by public.delete_my_account() (migration
 * 20261005400001_account_security.sql) with { profile_id, auth_user_id }.
 *
 * 1. Delete{actor} to every inbox captured in deleted_actors, signed with the retained key
 *    under the original keyId (SignatureService resolves both for a deleted profile, so
 *    the delivery queue's retries sign the same way). delivered_at marks the fan-out done.
 * 2. Avatar and banner objects under the account's folders. Message and post attachments
 *    stay with the content that references them.
 *
 * Delivery precedes the storage purge: a storage failure retries the job without sending
 * the Delete twice.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { buildActorDelete, deletedActorByProfile } from '../../activitypub/deletedActors.js';
import { logger } from '../../utils/logger.js';

export interface AccountDeletedJobData {
  profile_id: string;
  auth_user_id?: string | null;
}

export const PROFILE_MEDIA_BUCKETS = ['avatars', 'banners'] as const;

export async function handleAccountDeletedJob(data: AccountDeletedJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const tombstone = await deletedActorByProfile(data.profile_id);

  if (tombstone && !tombstone.delivered_at) {
    if (tombstone.private_key && tombstone.inboxes.length > 0) {
      const activity = buildActorDelete(tombstone.actor_uri);
      for (const inbox of tombstone.inboxes) {
        await DeliveryQueue.enqueue(activity, inbox, data.profile_id);
      }
      logger.info(`Actor Delete for ${tombstone.actor_uri} sent to ${tombstone.inboxes.length} inbox(es)`);
    }
    const { error } = await supabase
      .from('deleted_actors')
      .update({ delivered_at: new Date().toISOString() })
      .eq('profile_id', data.profile_id);
    if (error) throw error;
  }

  const folders = Array.from(new Set([data.auth_user_id, data.profile_id].filter((v): v is string => !!v)));
  await purgeProfileMedia(folders);
}

async function purgeProfileMedia(folders: string[]): Promise<void> {
  const storage = getSupabaseClient().storage;
  for (const bucket of PROFILE_MEDIA_BUCKETS) {
    for (const folder of folders) {
      const { data: objects, error } = await storage.from(bucket).list(folder, { limit: 1000 });
      if (error) throw new Error(`list ${bucket}/${folder}: ${error.message}`);
      // Folders list with a null id.
      const paths = (objects ?? []).filter((o) => o.name && o.id != null).map((o) => `${folder}/${o.name}`);
      if (paths.length === 0) continue;
      const { error: removeError } = await storage.from(bucket).remove(paths);
      if (removeError) throw new Error(`remove ${bucket}/${folder}: ${removeError.message}`);
      logger.info(`Removed ${paths.length} object(s) from ${bucket}/${folder}`);
    }
  }
}
