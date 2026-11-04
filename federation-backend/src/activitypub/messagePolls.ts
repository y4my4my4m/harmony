/**
 * Chat message polls over federation (db_schema 20261105990001_federated_message_polls.sql).
 *
 * One instance holds a poll's tally: the server's host for a poll in a channel, the author's
 * instance for a poll in a direct message. The poll's id is its message's Note id
 * (messageObjectId). Every other instance stores a copy (message_polls.remote) with the holder's
 * counts and its own voters' answers.
 *
 * The poll in a message:
 *   - a channel message Note, and a direct message Note to Harmony, carries it as `harmony:poll`:
 *     `name` (the question) and a Question's poll fields, `oneOf` (one answer) or `anyOf` (several),
 *     each answer `{ type: 'Note', name, replies: { type: 'Collection', totalItems: <votes> } }`,
 *     `endTime`, `closed` (the close time, once closed) and `votersCount`. `content` and
 *     `harmony:rawContent` keep the text create_message_poll writes beside the poll, which Harmony
 *     before 1.9.3 shows; a Note stays a Note there, so no older Harmony stores it as a post.
 *   - a direct message to other software is a `Question` with those fields and the question as
 *     its content, the form Mastodon sends a poll in.
 *
 * Activities about it:
 *   - a vote is Mastodon's (pollVoteHandler.ts): Create{Note{name: <answer>, inReplyTo: <poll id>}}
 *     without content, one per answer, to the holder alone: the Group's inbox for a channel poll,
 *     the author's for a direct message. Final, as on Mastodon. Who voted stays with the holder
 *     and the voter's instance.
 *   - the holder's counts and end: Update{Question{id: <poll id>, poll fields}}, by the server's
 *     Group to each instance with a member who views the channel, or by the author to each
 *     participant. Harmony before 1.9.3 looks for a post with that id, finds none and drops it.
 *   - the author ends a poll the host holds: Update{Question{id, closed}} to the Group's inbox.
 */

import { randomUUID } from 'crypto';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { decodeHtmlEntities } from '../utils/contentUtils.js';
import { pollPartText, questionPollMetadata } from '../utils/polls.js';
import { sameOrigin } from '../utils/apOrigin.js';
import { SignatureService } from './SignatureService.js';
import { logDenied } from './channelWriteAuthz.js';

export const POLL_QUESTION_MAX = 300;
export const POLL_ANSWER_MAX = 100;
const MIN_ANSWERS = 2;
const MAX_ANSWERS = 10;
/** A poll lasts at most 7 days (create_message_poll). */
const MAX_DURATION_MS = 7 * 24 * 3600_000;
const DEFAULT_DURATION_MS = 24 * 3600_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A poll as message_poll_federation_state returns it. */
export interface FederatedPoll {
  messageId: string;
  pollId: string;
  question: string;
  allowMultiple: boolean;
  expiresAt: string | null;
  remote: boolean;
  apId: string | null;
  voters: number;
  options: Array<{ position: number; text: string; votes: number }>;
}

const count = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export function hasPollPart(content: unknown): boolean {
  return Array.isArray(content) && content.some((p) => p && typeof p === 'object' && (p as any).type === 'poll');
}

function pollFromRow(row: any): FederatedPoll {
  return {
    messageId: String(row.message_id),
    pollId: String(row.poll_id),
    question: String(row.question ?? ''),
    allowMultiple: row.allow_multiple === true,
    expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
    remote: row.remote === true,
    apId: typeof row.ap_id === 'string' && row.ap_id ? row.ap_id : null,
    voters: count(row.voters),
    options: (Array.isArray(row.options) ? row.options : [])
      .map((o: any) => ({ position: count(o?.position), text: String(o?.text ?? ''), votes: count(o?.votes) }))
      .sort((a: { position: number }, b: { position: number }) => a.position - b.position),
  };
}

/** The polls of messages, by message id. A failed read yields none. */
export async function loadMessagePolls(supabase: any, messageIds: string[]): Promise<Map<string, FederatedPoll>> {
  const ids = [...new Set(messageIds.filter((id) => typeof id === 'string' && id))];
  const polls = new Map<string, FederatedPoll>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabase.rpc('message_poll_federation_state', { p_message_ids: ids.slice(i, i + 500) });
    if (error) {
      logger.warn(`message_poll_federation_state failed: ${error.message}`);
      return polls;
    }
    for (const row of data ?? []) polls.set(String(row.message_id), pollFromRow(row));
  }
  return polls;
}

/** Sets `poll` on the rows whose content holds a poll part, for channelMessageActivity. */
export async function withMessagePolls(supabase: any, rows: any[]): Promise<void> {
  const ids = rows.filter((m) => m?.id && hasPollPart(m.content)).map((m) => m.id as string);
  if (ids.length === 0) return;
  const polls = await loadMessagePolls(supabase, ids);
  for (const m of rows) {
    const poll = polls.get(m?.id);
    if (poll) m.poll = poll;
  }
}

/** The Question poll fields of a poll: oneOf or anyOf, endTime, closed once ended, votersCount. */
export function pollQuestionFields(poll: FederatedPoll, now: number = Date.now()): Record<string, unknown> {
  const answers = poll.options.map((o) => ({
    type: 'Note',
    name: o.text,
    replies: { type: 'Collection', totalItems: o.votes },
  }));
  const end = poll.expiresAt ? Date.parse(poll.expiresAt) : NaN;
  const endTime = Number.isNaN(end) ? undefined : new Date(end).toISOString();
  return {
    [poll.allowMultiple ? 'anyOf' : 'oneOf']: answers,
    ...(endTime ? { endTime } : {}),
    ...(endTime && end <= now ? { closed: endTime } : {}),
    votersCount: poll.voters,
  };
}

/** `harmony:poll` of a Note: the question as `name` beside the poll fields. */
export function harmonyPollExtension(poll: FederatedPoll, now: number = Date.now()): Record<string, unknown> {
  return { type: 'Question', name: poll.question, ...pollQuestionFields(poll, now) };
}

/** Context terms a Question's poll fields need outside the ActivityStreams vocabulary. */
export const QUESTION_CONTEXT = { toot: 'http://joinmastodon.org/ns#', votersCount: 'toot:votersCount' };

/** The poll fields of a Question-shaped object, unchecked. */
export interface ParsedPollFields {
  answers: Array<{ name: string; votes: number }>;
  allowMultiple: boolean;
  voters: number;
  /** When it ends: its close time once closed (now for `closed: true`), else endTime. */
  endsAt: string | null;
}

export function parsePollFields(source: any, now: number = Date.now()): ParsedPollFields {
  const meta = questionPollMetadata(source, now);
  const closedAt = typeof source?.closed === 'string' && !Number.isNaN(Date.parse(source.closed)) ? source.closed : null;
  const endTime = typeof source?.endTime === 'string' && !Number.isNaN(Date.parse(source.endTime)) ? source.endTime : null;
  const endsAt = closedAt ?? (source?.closed === true ? new Date(now).toISOString() : endTime);
  const sum = meta.poll_options.reduce((acc, o) => acc + o.votes, 0);
  return {
    answers: meta.poll_options,
    allowMultiple: meta.poll_multiple_choice,
    // Mastodon before 3.0 sends no votersCount; one answer per voter makes it the sum.
    voters: meta.poll_voters_count || (meta.poll_multiple_choice ? 0 : sum),
    endsAt: endsAt ? new Date(Date.parse(endsAt)).toISOString() : null,
  };
}

/** A poll arriving in a message, checked as create_message_poll checks one. */
export interface InboundPoll extends ParsedPollFields {
  question: string;
  options: string[];
  votes: number[];
}

/** Plain text of a Question's HTML content, without the leading mentions Mastodon writes. */
export function questionText(html: unknown): string {
  if (typeof html !== 'string') return '';
  const text = decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  );
  return text
    .replace(/^(?:\s*@[\w.-]+(?:@[\w.-]+)?)+\s*/u, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function checkedPoll(fields: ParsedPollFields, question: string): InboundPoll | null {
  const q = question.trim().slice(0, POLL_QUESTION_MAX).trim();
  const options = fields.answers.map((a) => a.name.trim().slice(0, POLL_ANSWER_MAX).trim());
  if (!q || options.length < MIN_ANSWERS || options.length > MAX_ANSWERS || options.some((o) => !o)) return null;
  return { ...fields, question: q, options, votes: fields.answers.map((a) => a.votes) };
}

/**
 * The poll a message's object carries: `harmony:poll` on a Note, or a Question's own fields.
 * Null for none, and for one this instance cannot hold: no question, fewer than 2 or more than
 * 10 answers, an empty answer.
 */
export function inboundPollOf(object: any, now: number = Date.now()): InboundPoll | null {
  const embedded = object?.['harmony:poll'];
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
    return checkedPoll(parsePollFields(embedded, now), typeof embedded.name === 'string' ? embedded.name : '');
  }
  if (object?.type === 'Question') {
    const question = questionText(object.content) || (typeof object.name === 'string' ? object.name : '');
    return checkedPoll(parsePollFields(object, now), question);
  }
  return null;
}

/**
 * `content` with a poll part naming pollId in front: the part a client renders, as
 * create_message_poll writes it. Content without text gets the poll spelled out.
 */
export function withPollPart(content: any[], pollId: string, poll: InboundPoll): any[] {
  const part = {
    type: 'poll',
    pollId,
    question: poll.question,
    options: poll.options,
    allowMultiple: poll.allowMultiple,
    expiresAt: poll.endsAt,
  };
  const rest = (Array.isArray(content) ? content : []).filter((p) => !(p && typeof p === 'object' && p.type === 'poll'));
  const hasText = rest.some((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim());
  return [part, ...rest, ...(hasText ? [] : [{ type: 'text', text: pollPartText(part) }])];
}

/** A new poll id and the content to store with it, or null when the object carries no poll. */
export function preparePoll(object: any, content: any[]): { pollId: string; poll: InboundPoll; content: any[] } | null {
  const poll = inboundPollOf(object);
  if (!poll) return null;
  const pollId = randomUUID();
  return { pollId, poll, content: withPollPart(content, pollId, poll) };
}

/**
 * Stores the poll of a message just inserted with withPollPart's content. A copy keeps the
 * holder's counts; a poll held here starts from none and ends within 7 days of now, after 24
 * hours when the Note names no end.
 */
export async function storeInboundPoll(
  supabase: any,
  messageId: string,
  pollId: string,
  poll: InboundPoll,
  opts: { remote: boolean; apId: string | null },
): Promise<boolean> {
  let expiresAt = poll.endsAt;
  if (!opts.remote) {
    const now = Date.now();
    const end = expiresAt ? Date.parse(expiresAt) : NaN;
    expiresAt = new Date(Number.isNaN(end) ? now + DEFAULT_DURATION_MS : Math.min(end, now + MAX_DURATION_MS)).toISOString();
  }
  const { data, error } = await supabase.rpc('store_federated_message_poll', {
    p_message_id: messageId,
    p_poll_id: pollId,
    p_question: poll.question,
    p_options: poll.options,
    p_allow_multiple: poll.allowMultiple,
    p_expires_at: expiresAt,
    p_remote: opts.remote,
    p_ap_id: opts.apId,
    p_votes: poll.votes,
    p_voters: poll.voters,
  });
  if (error || !data) {
    logger.warn(`Poll of message ${messageId} not stored${error ? `: ${error.message}` : ''}`);
    return false;
  }
  return true;
}

/**
 * Mastodon's vote: a Note with `name` and `inReplyTo` and no content
 * (ActivityPub::Activity::Create#poll_vote?).
 */
export function isPollVoteNote(object: any): boolean {
  return object?.type === 'Note'
    && typeof object.name === 'string' && object.name.trim() !== ''
    && typeof object.inReplyTo === 'string' && object.inReplyTo !== ''
    && !(typeof object.content === 'string' && object.content.trim() !== '')
    && !Array.isArray(object['harmony:rawContent']);
}

/** A message poll stored here and what decides who may act on it. */
export interface MessagePollRef {
  pollId: string;
  messageId: string;
  remote: boolean;
  apId: string | null;
  channelId: string | null;
  conversationId: string | null;
  authorId: string | null;
  serverId: string | null;
  messageApId: string | null;
}

const POLL_REF_COLUMNS = 'id, remote, ap_id, message:messages!inner(id, channel_id, conversation_id, user_id, metadata, channel:channels!messages_channel_id_fkey(server_id))';

function refFromRow(row: any): MessagePollRef {
  const message = row.message ?? {};
  return {
    pollId: String(row.id),
    messageId: String(message.id),
    remote: row.remote === true,
    apId: typeof row.ap_id === 'string' ? row.ap_id : null,
    channelId: message.channel_id ?? null,
    conversationId: message.conversation_id ?? null,
    authorId: message.user_id ?? null,
    serverId: message.channel?.server_id ?? null,
    messageApId: typeof message.metadata?.ap_id === 'string' ? message.metadata.ap_id : null,
  };
}

export async function messagePollById(supabase: any, pollId: string): Promise<MessagePollRef | null> {
  const { data } = await supabase.from('message_polls').select(POLL_REF_COLUMNS).eq('id', pollId).maybeSingle();
  return data ? refFromRow(data) : null;
}

/**
 * The message poll an ActivityPub id names here: this instance's /messages/<uuid> for a message
 * stored under no other id, else a poll stored with that ap_id.
 */
export async function messagePollByObjectId(supabase: any, objectId: unknown): Promise<MessagePollRef | null> {
  if (typeof objectId !== 'string' || !/^https?:\/\//i.test(objectId)) return null;
  const domain = config.INSTANCE_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`^https://${domain}/messages/(${UUID})$`, 'i').exec(objectId)?.[1];
  if (own) {
    const { data } = await supabase.from('message_polls').select(POLL_REF_COLUMNS).eq('message_id', own).maybeSingle();
    const ref = data ? refFromRow(data) : null;
    // A row holding another instance's message under the same uuid is not this instance's message.
    return ref && (ref.messageApId === null || ref.messageApId === objectId) ? ref : null;
  }
  const { data } = await supabase.from('message_polls').select(POLL_REF_COLUMNS).eq('ap_id', objectId).maybeSingle();
  return data ? refFromRow(data) : null;
}

/** The poll's ActivityPub id: its message's Note id. */
export function pollObjectId(ref: Pick<MessagePollRef, 'apId' | 'messageApId' | 'messageId'>): string {
  const apId = ref.apId ?? ref.messageApId;
  return apId && /^https?:\/\//i.test(apId) ? apId : `https://${config.INSTANCE_DOMAIN}/messages/${ref.messageId}`;
}

/**
 * A vote Note on a poll held here. A channel poll takes votes at its server's inbox
 * (opts.serverId), a direct message poll at its author's. Returns false when inReplyTo names no
 * message poll here; the activity is then something else.
 */
export async function receivePollVote(
  supabase: any,
  activity: any,
  object: any,
  opts: { serverId?: string; resolveActor: (actorUrl: string) => Promise<{ id: string } | null> },
): Promise<boolean> {
  const ref = await messagePollByObjectId(supabase, object.inReplyTo);
  if (!ref) return false;

  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  if (typeof actorUrl !== 'string') return true;
  if (ref.remote) {
    logDenied('poll vote', actorUrl, `${object.inReplyTo} is held by another instance`);
    return true;
  }
  if (opts.serverId ? ref.serverId !== opts.serverId : ref.channelId !== null) {
    logDenied('poll vote', actorUrl, `${object.inReplyTo} takes votes at ${ref.channelId ? 'its server\'s inbox' : 'its author\'s inbox'}`);
    return true;
  }
  if ((object.attributedTo && !SignatureService.verifyActorMatch(actorUrl, String(object.attributedTo)))
      || (object.id && !sameOrigin(object.id, actorUrl))) {
    logDenied('poll vote', actorUrl, 'the vote is not the actor\'s');
    return true;
  }
  const voter = await opts.resolveActor(actorUrl);
  if (!voter) {
    logDenied('poll vote', actorUrl, 'unknown actor');
    return true;
  }
  const { data, error } = await supabase.rpc('record_federated_message_poll_vote', {
    p_poll_id: ref.pollId,
    p_voter_id: voter.id,
    p_answer: object.name,
  });
  if (error) {
    logger.error(`record_federated_message_poll_vote failed for ${ref.pollId}: ${error.message}`);
  } else if (data !== 'recorded') {
    logDenied('poll vote', actorUrl, `${data} (${object.inReplyTo})`);
  } else {
    logger.info(`Poll vote from ${actorUrl} recorded on ${ref.pollId}`);
  }
  return true;
}

/**
 * The holder's Update(Question) of a copy here: by the Group of the copied server for a channel
 * poll, by the author for a direct message poll. Returns false when the id names no message poll.
 */
export async function receivePollState(supabase: any, actorUrl: string, object: any): Promise<boolean> {
  const ref = await messagePollByObjectId(supabase, object?.id);
  if (!ref) return false;
  if (!ref.remote) {
    logDenied('poll update', actorUrl, `${object.id} is held here`);
    return true;
  }

  let holder: string | null = null;
  if (ref.serverId) {
    const { data: server } = await supabase
      .from('servers').select('ap_id, is_local_server').eq('id', ref.serverId).maybeSingle();
    holder = server?.is_local_server === false && typeof server.ap_id === 'string' ? server.ap_id : null;
  } else if (ref.authorId) {
    const { data: author } = await supabase
      .from('profiles').select('federated_id, is_local').eq('id', ref.authorId).maybeSingle();
    holder = author?.is_local === false && typeof author.federated_id === 'string' ? author.federated_id : null;
  }
  if (!holder || !SignatureService.verifyActorMatch(actorUrl, holder)) {
    logDenied('poll update', actorUrl, `not the holder of ${object.id}`);
    return true;
  }

  const fields = parsePollFields(object);
  const { error } = await supabase.rpc('apply_federated_message_poll_state', {
    p_poll_id: ref.pollId,
    p_votes: fields.answers.length > 0 ? fields.answers.map((a) => a.votes) : null,
    p_voters: fields.voters,
    p_expires_at: fields.endsAt,
  });
  if (error) logger.error(`apply_federated_message_poll_state failed for ${ref.pollId}: ${error.message}`);
  else logger.info(`Poll ${ref.pollId} updated by ${actorUrl}`);
  return true;
}

/**
 * The author's Update(Question) at the Group inbox of a server hosted here: ends their poll.
 */
export async function receivePollEnd(
  supabase: any,
  serverId: string,
  activity: any,
  object: any,
  resolveActor: (actorUrl: string) => Promise<{ id: string } | null>,
): Promise<void> {
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  const ref = await messagePollByObjectId(supabase, object?.id);
  if (!ref || ref.serverId !== serverId || typeof actorUrl !== 'string') {
    logger.info(`Update(Question) at server ${serverId} names no poll of its channels: ${object?.id}`);
    return;
  }
  const fields = parsePollFields(object);
  if (!fields.endsAt || Date.parse(fields.endsAt) > Date.now()) {
    logger.info(`Update(Question) of ${object.id} from ${actorUrl} does not end it`);
    return;
  }
  const actor = await resolveActor(actorUrl);
  const { data, error } = actor
    ? await supabase.rpc('end_federated_message_poll', { p_poll_id: ref.pollId, p_actor_id: actor.id })
    : { data: false, error: null };
  if (error) logger.error(`end_federated_message_poll failed for ${ref.pollId}: ${error.message}`);
  else if (!data) logDenied('poll end', actorUrl, `not the author of an open poll ${object.id}`);
  else logger.info(`Poll ${ref.pollId} ended by its author ${actorUrl}`);
}

/**
 * Whether a direct message poll goes to `host` as a Question. Harmony gets the Note with
 * `harmony:poll`, which Harmony before 1.9.3 shows as text; so does a host whose software is
 * unknown, which may be such a Harmony: a Question reaches it as a post.
 */
export async function sendsQuestionTo(host: string): Promise<boolean> {
  const { instanceSoftware } = await import('./instanceSoftware.js');
  const software = await instanceSoftware(host);
  return !!software && software !== 'harmony';
}

/** A direct message's poll as a Question, the question as its content. */
export function dmPollQuestion(base: Record<string, any>, poll: FederatedPoll, now: number = Date.now()): Record<string, any> {
  const { 'harmony:poll': _embedded, contentMap: _contentMap, ...rest } = base;
  const content = `<p>${escapeQuestion(poll.question)}</p>`;
  return { ...rest, type: 'Question', content, contentMap: { en: content }, ...pollQuestionFields(poll, now) };
}

function escapeQuestion(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br />');
}

/**
 * The counts a channel page of the server's host carries for a copy here, in channelId. The
 * page is read from the host, which holds the tally.
 */
export async function applyPagePollState(supabase: any, note: any, channelId: string): Promise<void> {
  const embedded = note?.['harmony:poll'];
  if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded)) return;
  const ref = await messagePollByObjectId(supabase, note.id);
  if (!ref?.remote || ref.channelId !== channelId) return;
  const fields = parsePollFields(embedded);
  const { error } = await supabase.rpc('apply_federated_message_poll_state', {
    p_poll_id: ref.pollId,
    p_votes: fields.answers.length > 0 ? fields.answers.map((a) => a.votes) : null,
    p_voters: fields.voters,
    p_expires_at: fields.endsAt,
  });
  if (error) logger.warn(`apply_federated_message_poll_state failed for ${ref.pollId}: ${error.message}`);
}
