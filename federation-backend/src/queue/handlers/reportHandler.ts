/**
 * Report Federation Job Handler
 * 
 * Processes federate-report jobs (reports sent to remote instance admins)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleReportJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { report_id, reporter_id, reported_user_id, reported_post_id, reason } = data;

  logger.info(`🚩 Processing report job for report ${report_id}`);

  try {
    const { data: reporter } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', reporter_id)
      .single();

    if (!reporter || !reporter.is_local) {
      logger.debug('Report from remote user, skipping');
      await updateFederationStatus(report_id, 'reports', 'skipped');
      return;
    }

    const { data: reportedUser } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', reported_user_id)
      .single();

    if (!reportedUser || reportedUser.is_local) {
      logger.debug('Report about local user, no federation needed');
      await updateFederationStatus(report_id, 'reports', 'skipped');
      return;
    }

    await updateFederationStatus(report_id, 'reports', 'processing');

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const reporterActorUrl = `${baseUrl}/users/${reporter.username}`;

    const reportObjects: string[] = [reportedUser.federated_id || reportedUser.ap_id];

    // If there's a reported post, include it
    if (reported_post_id) {
      const { data: reportedPost } = await supabase
        .from('posts')
        .select('ap_id')
        .eq('id', reported_post_id)
        .single();

      if (reportedPost?.ap_id) {
        reportObjects.push(reportedPost.ap_id);
      }
    }

    const flagActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${baseUrl}/activities/flag/${report_id}`,
      type: 'Flag',
      actor: reporterActorUrl,
      object: reportObjects,
      content: reason || 'Reported for review'
    };

    // Get the shared inbox for the reported user's instance
    // First try to get instance's shared inbox, fall back to user inbox
    const targetInbox = reportedUser.shared_inbox_url || reportedUser.inbox_url;

    if (targetInbox) {
      await DeliveryQueue.sendToInbox(targetInbox, flagActivity, reporter.id);
      logger.info(`✅ Report sent to ${targetInbox}`);
    } else {
      logger.warn(`No inbox found for reported user's instance`);
    }

    await updateFederationStatus(report_id, 'reports', 'completed');

  } catch (error) {
    logger.error(`Failed to federate report ${report_id}:`, error);
    await updateFederationStatus(report_id, 'reports', 'failed');
    throw error;
  }
}

async function updateFederationStatus(
  id: string,
  table: string,
  status: string
): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from(table).update({ federation_status: status }).eq('id', id);
}

