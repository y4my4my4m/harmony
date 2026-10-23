/**
 * federate-report, by job data target:
 *
 *   (none)       a local report about a remote account, to that account's instance as a
 *                Flag signed by the instance actor. Mirrors Mastodon
 *                ReportService#forward_to_origin!: the Flag names the account and the
 *                reported statuses and carries the comment; the reporter appears nowhere in
 *                it. Deviation: Mastodon delivers to the account's inbox_url; this uses the
 *                shared inbox when there is one, because Harmony instances that predate Flag
 *                handling at personal inboxes drop an unaddressed Flag there.
 *   'server'     a local report about a message in a server hosted elsewhere, to that
 *                server's Group inbox as a Flag signed by the instance actor
 *                (flag.ts buildServerFlagActivity); reports.server_forward_status.
 *   'resolution' on the host: a report filed from such a Flag was resolved or dismissed;
 *                the Group's Resolve goes to the Flag actor's shared inbox, signed with the
 *                Group's key (flag.ts buildResolveActivity).
 *
 * Job data carries only report_id and target; everything else is read from the report row.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { instanceActorUrl } from '../../activitypub/InstanceActor.js';
import {
  buildFlagActivity,
  buildResolveActivity,
  buildServerFlagActivity,
  type ReportOutcome,
} from '../../activitypub/flag.js';
import { readApDocument, sameOrigin } from '../../utils/apOrigin.js';
import { SignatureService } from '../../activitypub/SignatureService.js';
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
  if (data.target === 'server') {
    await forwardToServer(reportId);
    return;
  }
  if (data.target === 'resolution') {
    await sendResolution(reportId);
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

// ---------------------------------------------------------------------------
// Reports about a message in a server hosted elsewhere
// ---------------------------------------------------------------------------

interface ServerReportRow {
  id: string;
  source: string | null;
  forward_to_server: boolean | null;
  server_forwarded_at: string | null;
  reported_message_id: string | null;
  reason: string | null;
  comment: string | null;
  content_snapshot: { message?: { id?: string; user_id?: string | null; server_id?: string } } | null;
}

async function setServerStatus(reportId: string, status: string, forwardedAt?: string): Promise<void> {
  const values: Record<string, string> = { server_forward_status: status };
  if (forwardedAt) values.server_forwarded_at = forwardedAt;
  const { error } = await getSupabaseClient().from('reports').update(values).eq('id', reportId);
  if (error) {
    logger.warn(`Report ${reportId}: server_forward_status ${status} not recorded: ${error.message}`);
  }
}

/**
 * Whether the Group's host files Flags naming its messages for the server's moderators: the
 * copy's last sync says so, else the Group document, fetched now (harmony:acceptsReports).
 */
async function groupAcceptsReports(groupUri: string, metadata: unknown): Promise<boolean> {
  if ((metadata as { accepts_reports?: unknown } | null)?.accepts_reports === true) return true;
  try {
    const response = await SignatureService.signedApFetch(groupUri);
    const fetched = await readApDocument(response, groupUri);
    return !!fetched && sameOrigin(fetched.doc?.id, groupUri) && fetched.doc['harmony:acceptsReports'] === true;
  } catch (error) {
    logger.warn(`Group ${groupUri} unreadable while checking reports:`, error);
    return false;
  }
}

/** Actor URI of a message author as the Group knows it. */
function authorUri(author: { federated_id: string | null; username: string | null; is_local: boolean | null } | null): string | null {
  if (!author) return null;
  if (author.federated_id) return author.federated_id;
  return author.is_local !== false && author.username ? `https://${config.INSTANCE_DOMAIN}/users/${author.username}` : null;
}

async function forwardToServer(reportId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data: report, error } = await supabase
    .from('reports')
    .select('id, source, forward_to_server, server_forwarded_at, reported_message_id, reason, comment, content_snapshot')
    .eq('id', reportId)
    .maybeSingle<ServerReportRow>();
  if (error) {
    throw new Error(`report ${reportId} unreadable: ${error.message}`);
  }
  if (!report) {
    logger.info(`Report ${reportId} no longer exists; nothing to send to its server`);
    return;
  }
  if (report.server_forwarded_at) {
    logger.debug(`Report ${reportId} already sent to its server`);
    return;
  }
  if (report.source !== 'local' || !report.forward_to_server) {
    await setServerStatus(reportId, 'skipped');
    return;
  }

  const snapshot = report.content_snapshot?.message ?? {};
  const messageId = report.reported_message_id ?? snapshot.id ?? null;
  const { data: message } = messageId
    ? await supabase.from('messages').select('id, channel_id, user_id, metadata').eq('id', messageId).maybeSingle()
    : { data: null };
  let serverId: string | null = snapshot.server_id ?? null;
  if (message?.channel_id) {
    const { data: channel } = await supabase.from('channels').select('server_id').eq('id', message.channel_id).maybeSingle();
    serverId = channel?.server_id ?? serverId;
  }
  const { data: server } = serverId
    ? await supabase.from('servers').select('id, is_local_server, ap_id, federation_inbox_url, federation_metadata').eq('id', serverId).maybeSingle()
    : { data: null };
  if (!messageId || !server || server.is_local_server !== false || !server.ap_id) {
    await setServerStatus(reportId, 'skipped');
    return;
  }
  // A host before 1.8.12 answers a Flag at the Group inbox 202 and drops it.
  if (!(await groupAcceptsReports(server.ap_id, server.federation_metadata))) {
    logger.info(`Report ${reportId}: ${server.ap_id} takes no reports for its servers; not sent`);
    await setServerStatus(reportId, 'skipped');
    return;
  }

  const authorId = message?.user_id ?? snapshot.user_id ?? null;
  const { data: author } = authorId
    ? await supabase.from('profiles').select('federated_id, username, is_local').eq('id', authorId).maybeSingle()
    : { data: null };
  const storedApId = (message?.metadata as { ap_id?: unknown } | null)?.ap_id;
  const messageUri = typeof storedApId === 'string' && storedApId
    ? storedApId
    : `https://${config.INSTANCE_DOMAIN}/messages/${messageId}`;
  const inbox = server.federation_inbox_url || `${server.ap_id}/inbox`;

  await setServerStatus(reportId, 'processing');
  const flag = buildServerFlagActivity({
    baseUrl: `https://${config.INSTANCE_DOMAIN}`,
    reportId,
    actor: instanceActorUrl(),
    groupUri: server.ap_id,
    authorUri: authorUri(author),
    messageUri,
    comment: report.comment,
    reason: report.reason,
  });

  const result = await DeliveryQueue.deliverAsInstanceActor(flag, inbox);
  if (result.delivered) {
    await setServerStatus(reportId, 'completed', new Date().toISOString());
    logger.info(`Report ${reportId} sent to the moderators of ${server.ap_id}`);
    return;
  }
  await setServerStatus(reportId, 'failed');
  if (result.retry) {
    throw new Error(`Flag for report ${reportId} not delivered to ${inbox}; retrying`);
  }
  logger.warn(`Flag for report ${reportId} refused by ${inbox}; not retried`);
}

interface ResolvedReportRow {
  id: string;
  status: string;
  source: string | null;
  scope_server_id: string | null;
  ap_id: string | null;
  source_instance: string | null;
  resolved_at: string | null;
  metadata: { actor?: unknown; flag_target?: unknown } | null;
}

/** Shared inbox of the actor that sent a Flag, else its inbox; on the actor's own host only. */
async function flagActorInbox(actorUrl: string): Promise<string | null> {
  // Loaded on use: ActivityProcessor pulls in most of the backend.
  const { ActivityProcessor } = await import('../../activitypub/ActivityProcessor.js');
  const fetched = await ActivityProcessor.fetchApDocument(actorUrl);
  const doc = fetched?.doc;
  for (const inbox of [doc?.endpoints?.sharedInbox, doc?.inbox]) {
    if (typeof inbox === 'string' && sameOrigin(inbox, actorUrl)) return inbox;
  }
  return null;
}

async function sendResolution(reportId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data: report, error } = await supabase
    .from('reports')
    .select('id, status, source, scope_server_id, ap_id, source_instance, resolved_at, metadata')
    .eq('id', reportId)
    .maybeSingle<ResolvedReportRow>();
  if (error) {
    throw new Error(`report ${reportId} unreadable: ${error.message}`);
  }
  if (!report || report.source !== 'federation' || report.metadata?.flag_target !== 'group'
      || !report.scope_server_id || !report.ap_id) {
    return;
  }
  if (report.status !== 'resolved' && report.status !== 'dismissed') {
    logger.info(`Report ${reportId} is ${report.status} again; no Resolve sent`);
    return;
  }
  const flagActor = report.metadata?.actor;
  if (typeof flagActor !== 'string' || !flagActor) {
    logger.warn(`Report ${reportId} names no Flag actor; no Resolve sent`);
    return;
  }

  const inbox = await flagActorInbox(flagActor);
  if (!inbox) {
    logger.warn(`Report ${reportId}: ${flagActor} publishes no inbox; no Resolve sent`);
    return;
  }

  const resolvedAt = report.resolved_at ?? new Date().toISOString();
  const activity = buildResolveActivity({
    groupUri: `https://${config.INSTANCE_DOMAIN}/servers/${report.scope_server_id}`,
    reportId,
    resolvedAt,
    flagId: report.ap_id,
    flagActor,
    outcome: report.status as ReportOutcome,
  });
  await DeliveryQueue.sendToInbox(inbox, activity, { serverId: report.scope_server_id });
  // metadata.resolution_sent_for: the resolved_at whose Resolve is queued; the sweep resends
  // a settled report without one (BullMQManager).
  const { error: markError } = await supabase
    .from('reports')
    .update({ metadata: { ...(report.metadata ?? {}), resolution_sent_for: resolvedAt } })
    .eq('id', reportId);
  if (markError) logger.warn(`Report ${reportId}: Resolve not marked sent: ${markError.message}`);
  logger.info(`Report ${reportId} ${report.status}: Resolve sent to ${inbox}`);
}
