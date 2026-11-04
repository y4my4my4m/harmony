/**
 * federate-message-poll: what message_poll_outbox holds for a chat message poll
 * (activitypub/messagePolls.ts has the shapes).
 *
 *   { poll_id, kind: 'vote', user_id }  a local voter's answers on a copy, to the holder
 *   { poll_id, kind: 'end' }            the local author ends a copy held by the server's host
 *   { poll_id, kind: 'state' }          counts and end of a poll held here, to every copy
 *
 * A 'state' job first queues itself again STATE_DELAY_MS later under one id per poll (BullMQ
 * deduplication in throttle mode), so the votes of those seconds go out as one Update; the
 * delayed run, stage 'send', reads the counts then. The outbox row is deleted when its
 * queued_at is not after the read; a change after it leaves the row for the job that change
 * queued, or for the worker's sweep.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { HARMONY_CONTEXT } from '../../activitypub/harmonyContext.js';
import {
  dmPollQuestion,
  loadMessagePolls,
  messagePollById,
  pollObjectId,
  pollQuestionFields,
  QUESTION_CONTEXT,
  sendsQuestionTo,
  type FederatedPoll,
  type MessagePollRef,
} from '../../activitypub/messagePolls.js';
import { getChannelRecipientGroups } from '../../utils/federationUtils.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';
import { pollVoteActivity } from './pollVoteHandler.js';

const AS = 'https://www.w3.org/ns/activitystreams';
/** Votes of this long go out as one Update. */
export const STATE_DELAY_MS = 2_000;

type Kind = 'vote' | 'end' | 'state';

async function clearOutbox(pollId: string, kind: Kind, userId: string | null, readAt: string): Promise<void> {
  let query = getSupabaseClient()
    .from('message_poll_outbox')
    .delete()
    .eq('poll_id', pollId)
    .eq('kind', kind)
    .lte('queued_at', readAt);
  query = userId ? query.eq('user_id', userId) : query.is('user_id', null);
  const { error } = await query;
  if (error) logger.warn(`message_poll_outbox ${pollId}/${kind}: not cleared: ${error.message}`);
}

const userUrl = (username: string) => `https://${config.INSTANCE_DOMAIN}/users/${username}`;

/** Where a copy's holder takes votes and ends: the Group of a copied server, or the remote author. */
async function holderOf(ref: MessagePollRef): Promise<{ actor: string; inbox: string; serverId?: string } | null> {
  const supabase = getSupabaseClient();
  if (ref.serverId) {
    const { data: server } = await supabase
      .from('servers').select('id, ap_id, federation_inbox_url, is_local_server').eq('id', ref.serverId).maybeSingle();
    if (server?.is_local_server !== false || !server.ap_id || !server.federation_inbox_url) return null;
    return { actor: server.ap_id, inbox: server.federation_inbox_url, serverId: server.id };
  }
  if (!ref.authorId) return null;
  const { data: author } = await supabase
    .from('profiles').select('federated_id, inbox_url, shared_inbox_url, is_local').eq('id', ref.authorId).maybeSingle();
  const inbox = author?.inbox_url || author?.shared_inbox_url;
  if (author?.is_local !== false || !author.federated_id || !inbox) return null;
  return { actor: author.federated_id, inbox };
}

async function sendVotes(ref: MessagePollRef, userId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const [{ data: voter }, { data: votes }, holder] = await Promise.all([
    supabase.from('profiles').select('id, username, is_local').eq('id', userId).maybeSingle(),
    supabase.from('message_poll_votes').select('option:message_poll_options!inner(position, text)')
      .eq('poll_id', ref.pollId).eq('user_id', userId),
    holderOf(ref),
  ]);
  if (!voter?.is_local || !holder) {
    logger.info(`Poll vote ${ref.pollId}/${userId}: no local voter or no holder to send to`);
    return;
  }
  const voterUrl = userUrl(voter.username);
  const target = pollObjectId(ref);
  for (const row of votes ?? []) {
    const option = (row as any).option;
    if (!option || typeof option.text !== 'string') continue;
    await DeliveryQueue.sendToInbox(
      holder.inbox,
      pollVoteActivity(voterUrl, holder.actor, target, ref.messageId, Number(option.position), option.text),
      voter.id,
    );
  }
  logger.info(`Poll vote ${ref.pollId}/${userId}: ${(votes ?? []).length} answer(s) sent to ${holder.inbox}`);
}

async function sendEnd(ref: MessagePollRef, poll: FederatedPoll): Promise<void> {
  const supabase = getSupabaseClient();
  const holder = await holderOf(ref);
  const { data: author } = ref.authorId
    ? await supabase.from('profiles').select('id, username, is_local').eq('id', ref.authorId).maybeSingle()
    : { data: null };
  if (!holder?.serverId || !author?.is_local) {
    logger.info(`Poll end ${ref.pollId}: no local author or no host to send to`);
    return;
  }
  const authorUrl = userUrl(author.username);
  const id = pollObjectId(ref);
  await DeliveryQueue.sendToInbox(holder.inbox, {
    '@context': [AS, QUESTION_CONTEXT, HARMONY_CONTEXT],
    id: `${id}#end/${Date.now()}`,
    type: 'Update',
    actor: authorUrl,
    to: [holder.actor],
    object: {
      type: 'Question',
      id,
      attributedTo: authorUrl,
      'harmony:serverId': holder.serverId,
      ...pollQuestionFields(poll),
    },
  }, author.id);
  logger.info(`Poll end ${ref.pollId} sent to ${holder.inbox}`);
}

async function sendState(ref: MessagePollRef, poll: FederatedPoll): Promise<void> {
  const supabase = getSupabaseClient();
  const id = pollObjectId(ref);
  const stamp = Date.now();

  if (ref.channelId && ref.serverId) {
    const { data: server } = await supabase
      .from('servers').select('id, is_local_server, federation_enabled').eq('id', ref.serverId).maybeSingle();
    if (server?.is_local_server === false || !server?.federation_enabled) return;
    const { data: author } = ref.authorId
      ? await supabase.from('profiles').select('username, federated_id, is_local').eq('id', ref.authorId).maybeSingle()
      : { data: null };
    const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${server.id}`;
    const object = {
      type: 'Question',
      id,
      ...(author ? { attributedTo: author.is_local ? userUrl(author.username) : author.federated_id } : {}),
      context: `${serverUrl}/channels/${ref.channelId}`,
      'harmony:serverId': server.id,
      ...pollQuestionFields(poll),
    };
    const groups = await getChannelRecipientGroups(ref.channelId);
    for (const group of groups) {
      await DeliveryQueue.enqueue({
        '@context': [AS, QUESTION_CONTEXT, HARMONY_CONTEXT],
        id: `${serverUrl}/polls/${ref.pollId}/updates/${stamp}`,
        type: 'Update',
        actor: serverUrl,
        to: group.member_ap_ids,
        cc: [`${serverUrl}/members`],
        object,
      }, group.shared_inbox || `https://${group.instance}/inbox`, { serverId: server.id });
    }
    logger.info(`Poll ${ref.pollId} counts sent to ${groups.length} instance(s)`);
    return;
  }

  if (!ref.conversationId || !ref.authorId) return;
  const { data: author } = await supabase
    .from('profiles').select('id, username, is_local').eq('id', ref.authorId).maybeSingle();
  if (!author?.is_local) return;
  const { data: participants } = await supabase
    .from('conversation_participants')
    .select('profile:profiles!inner(id, username, domain, federated_id, inbox_url, shared_inbox_url, is_local)')
    .eq('conversation_id', ref.conversationId)
    .is('left_at', null);
  const remote = (participants ?? [])
    .map((p: any) => p.profile)
    .filter((p: any) => p && p.is_local === false && p.domain && p.id !== author.id);
  const authorUrl = userUrl(author.username);
  const to = remote.map((p: any) => p.federated_id || `https://${p.domain}/users/${p.username}`);
  const base = { id, attributedTo: authorUrl, to, cc: [] };
  for (const profile of remote) {
    const inbox = profile.inbox_url || profile.shared_inbox_url || `https://${profile.domain}/inbox`;
    const object = await sendsQuestionTo(String(profile.domain))
      ? dmPollQuestion(base, poll)
      : { type: 'Question', ...base, ...pollQuestionFields(poll) };
    await DeliveryQueue.enqueue({
      '@context': [AS, QUESTION_CONTEXT, HARMONY_CONTEXT],
      id: `${id}#updates/${stamp}`,
      type: 'Update',
      actor: authorUrl,
      to,
      object,
    }, inbox, author.id);
  }
  logger.info(`Poll ${ref.pollId} counts sent to ${remote.length} participant(s)`);
}

export async function handleMessagePollJob(data: FederationJobData): Promise<void> {
  const pollId = data.poll_id;
  const kind = data.kind as Kind;
  const userId = typeof data.user_id === 'string' ? data.user_id : null;
  if (typeof pollId !== 'string' || !['vote', 'end', 'state'].includes(kind)) return;

  if (kind === 'state' && data.stage !== 'send') {
    let jobId: string | undefined;
    try {
      const { bullmqManager } = await import('../BullMQManager.js');
      jobId = await bullmqManager.addJob(
        'federate-message-poll',
        { type: 'update', poll_id: pollId, kind, user_id: null, stage: 'send' },
        { delayMs: STATE_DELAY_MS, dedupeId: `message-poll-state:${pollId}`, dedupeTtlMs: STATE_DELAY_MS },
      );
    } catch (error) {
      logger.warn(`Poll ${pollId} counts not delayed: ${(error as Error).message}`);
    }
    if (jobId) return;
  }

  const supabase = getSupabaseClient();
  const readAt = new Date().toISOString();
  const ref = await messagePollById(supabase, pollId);
  if (!ref) return;
  const poll = (await loadMessagePolls(supabase, [ref.messageId])).get(ref.messageId);
  if (!poll) return;

  if (kind === 'vote' && userId) await sendVotes(ref, userId);
  else if (kind === 'end') await sendEnd(ref, poll);
  else if (kind === 'state') await sendState(ref, poll);
  await clearOutbox(pollId, kind, kind === 'vote' ? userId : null, readAt);
}
