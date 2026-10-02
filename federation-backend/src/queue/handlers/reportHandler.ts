/**
 * federate-report: forwards a local report about a remote account to that
 * account's instance as a Flag signed by the instance actor.
 *
 * Mirrors Mastodon ReportService#forward_to_origin!: the Flag names the account
 * and the reported statuses and carries the comment; the reporter appears
 * nowhere in it. Deviation: Mastodon delivers to the account's inbox_url; this
 * uses the shared inbox when there is one, because Harmony instances that
 * predate Flag handling at personal inboxes drop an unaddressed Flag there.
 * Job data carries only report_id; everything else is read from the report row.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { instanceActorUrl } from '../../activitypub/InstanceActor.js';
import { buildFlagActivity } from '../../activitypub/flag.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';

interface ReportRow {
  id: string;
  source: string | null;
  forward: boolean | null;
  forwarded_at: string | null;
  reported_user_id: string | null;
  reported_post_id: string | null;
  comment: string | null;
  content_snapshot: { posts?: Array<{ ap_id?: string | null; author_id?: string; is_local?: boolean }> } | null;
}

interface TargetRow {
  id: string;
  is_local: boolean | null;
  federated_id: string | null;
  inbox_url: string | null;
  shared_inbox_url: string | null;
}

async function setStatus(reportId: string, status: string, forwardedAt?: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = forwardedAt
    ? await supabase.from('reports').update({ federation_status: status, forwarded_at: forwardedAt }).eq('id', reportId)
    : await supabase.from('reports').update({ federation_status: status }).eq('id', reportId);
  if (error) {
    logger.warn(`Report ${reportId}: federation_status ${status} not recorded: ${error.message}`);
  }
}

/** URIs of the reported remote statuses authored by the target. */
async function statusUris(report: ReportRow, target: TargetRow): Promise<string[]> {
  const uris: string[] = [];
  if (report.reported_post_id) {
    const supabase = getSupabaseClient();
    const { data: post } = await supabase
      .from('posts')
      .select('ap_id, author_id, is_local')
      .eq('id', report.reported_post_id)
      .maybeSingle();
    if (post?.ap_id && post.author_id === target.id && post.is_local === false) {
      uris.push(post.ap_id);
    }
  }
  // A post deleted since the report survives in the snapshot.
  for (const post of report.content_snapshot?.posts ?? []) {
    if (post?.ap_id && post.author_id === target.id && post.is_local === false && !uris.includes(post.ap_id)) {
      uris.push(post.ap_id);
    }
  }
  return uris;
}

export async function handleReportJob(data: FederationJobData): Promise<void> {
  const reportId = data.report_id;
  if (typeof reportId !== 'string' || !reportId) {
    logger.warn('federate-report job without report_id');
    return;
  }

  const supabase = getSupabaseClient();
  const { data: report, error } = await supabase
    .from('reports')
    .select('id, source, forward, forwarded_at, reported_user_id, reported_post_id, comment, content_snapshot')
    .eq('id', reportId)
    .maybeSingle<ReportRow>();

  if (error) {
    throw new Error(`report ${reportId} unreadable: ${error.message}`);
  }
  if (!report) {
    logger.info(`Report ${reportId} no longer exists; nothing to forward`);
    return;
  }
  if (report.forwarded_at) {
    logger.debug(`Report ${reportId} already forwarded`);
    return;
  }
  if (report.source !== 'local' || !report.forward || !report.reported_user_id) {
    await setStatus(reportId, 'skipped');
    return;
  }

  const { data: target } = await supabase
    .from('profiles')
    .select('id, is_local, federated_id, inbox_url, shared_inbox_url')
    .eq('id', report.reported_user_id)
    .maybeSingle<TargetRow>();

  if (!target || target.is_local !== false || !target.federated_id) {
    await setStatus(reportId, 'skipped');
    return;
  }

  const inbox = target.shared_inbox_url || target.inbox_url;
  if (!inbox) {
    logger.warn(`Report ${reportId}: ${target.federated_id} has no inbox`);
    await setStatus(reportId, 'failed');
    return;
  }

  await setStatus(reportId, 'processing');

  const flag = buildFlagActivity({
    baseUrl: `https://${config.INSTANCE_DOMAIN}`,
    reportId,
    actor: instanceActorUrl(),
    targetActorUri: target.federated_id,
    statusUris: await statusUris(report, target),
    comment: report.comment,
  });

  const result = await DeliveryQueue.deliverAsInstanceActor(flag, inbox);
  if (result.delivered) {
    await setStatus(reportId, 'completed', new Date().toISOString());
    logger.info(`Report ${reportId} forwarded to ${inbox}`);
    return;
  }

  await setStatus(reportId, 'failed');
  if (result.retry) {
    throw new Error(`Flag for report ${reportId} not delivered to ${inbox}; retrying`);
  }
  logger.warn(`Flag for report ${reportId} refused by ${inbox}; not retried`);
}
