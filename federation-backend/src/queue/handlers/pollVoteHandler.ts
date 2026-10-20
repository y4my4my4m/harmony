/**
 * federate-poll-vote: a local account's answers on a remote poll (public.vote_remote_poll),
 * delivered to the poll author's inbox as one Create per answer. Mirrors Mastodon's
 * ActivityPub::VoteSerializer:
 *
 *   Create { id: <voter>#votes/<post>/<choice>/activity, actor: <voter>, to: [<author>],
 *            object: Note { id: <voter>#votes/<post>/<choice>, attributedTo: <voter>,
 *                           name: <answer>, inReplyTo: <Question id>, to: [<author>] } }
 *
 * The author alone is addressed; the Note carries no content, which is how Mastodon and
 * Misskey tell a vote from a reply. Job data names the post and the voter; the answers are
 * the voter's rows of post_poll_votes without delivered_at. delivered_at is set once each
 * answer is handed to DeliveryQueue, which retries a failed delivery itself, and also for a
 * vote that has no remote poll author to reach.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

/** The Create carrying one answer of `voterUrl` on the Question `questionId`. */
export function pollVoteActivity(
  voterUrl: string,
  authorUrl: string,
  questionId: string,
  postId: string,
  choice: number,
  name: string,
): Record<string, unknown> {
  const noteId = `${voterUrl}#votes/${postId}/${choice}`;
  return {
    '@context': AS_CONTEXT,
    id: `${noteId}/activity`,
    type: 'Create',
    actor: voterUrl,
    to: [authorUrl],
    object: {
      id: noteId,
      type: 'Note',
      attributedTo: voterUrl,
      name,
      inReplyTo: questionId,
      to: [authorUrl],
    },
  };
}

async function markDelivered(postId: string, userId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('post_poll_votes')
    .update({ delivered_at: new Date().toISOString() })
    .eq('post_id', postId)
    .eq('user_id', userId)
    .is('delivered_at', null);
  if (error) logger.warn(`Poll vote ${postId}/${userId}: delivered_at not recorded: ${error.message}`);
}

export async function handlePollVoteJob(data: FederationJobData): Promise<void> {
  const { post_id: postId, user_id: userId } = data;
  if (typeof postId !== 'string' || typeof userId !== 'string') return;
  const supabase = getSupabaseClient();

  const { data: votes } = await supabase
    .from('post_poll_votes')
    .select('choice')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .is('delivered_at', null)
    .order('choice', { ascending: true });
  if (!votes?.length) return;

  const [{ data: voter }, { data: post }] = await Promise.all([
    supabase.from('profiles').select('id, username, is_local, deleted_at').eq('id', userId).maybeSingle(),
    supabase
      .from('posts')
      .select('id, ap_id, metadata, is_deleted, author:profiles!posts_author_id_fkey ( federated_id, inbox_url, shared_inbox_url, is_local )')
      .eq('id', postId)
      .maybeSingle(),
  ]);
  const author = (post as any)?.author;
  const inbox = author?.inbox_url || author?.shared_inbox_url;

  if (!voter?.is_local || voter.deleted_at || !post?.ap_id || post.is_deleted || author?.is_local !== false
      || !author.federated_id || !inbox) {
    logger.info(`Poll vote ${postId}/${userId}: no remote poll author to deliver to`);
    await markDelivered(postId, userId);
    return;
  }

  const options: any[] = Array.isArray(post.metadata?.poll_options) ? post.metadata.poll_options : [];
  const voterUrl = `https://${config.INSTANCE_DOMAIN}/users/${voter.username}`;
  for (const { choice } of votes) {
    const name = typeof options[choice]?.name === 'string' ? options[choice].name : null;
    if (!name) {
      logger.warn(`Poll vote ${postId}/${userId}: answer ${choice} names no option`);
      continue;
    }
    await DeliveryQueue.sendToInbox(inbox, pollVoteActivity(voterUrl, author.federated_id, post.ap_id, postId, choice, name), voter.id);
  }
  await markDelivered(postId, userId);
  logger.info(`Poll vote ${postId}/${userId}: ${votes.length} answer(s) sent to ${inbox}`);
}
