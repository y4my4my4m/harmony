/**
 * System notices (messages.is_system) on the wire.
 *
 * A system row has no author: the people it names are metadata ids, subject_id, actor_id
 * and actor_bot_id (migration 20261026100001_system_events). Its Note is attributedTo the
 * server's Group and carries `harmony:system`, with actor ids in place of profile ids:
 *
 *   harmony:system   { type, subject?, actor?, actorName?, reason?, thread?, threadName?, staff? }
 *     type           metadata.type, one of SYSTEM_NOTE_TYPES
 *     subject, actor actor ids of the member the notice is about and of the member who
 *                    acted; http or https, as fromActivityPub reads ids (ssrfProtection
 *                    refuses plain http fetches in production)
 *     actorName      display name of an actor with no actor id: a bot or a Discord member
 *     thread         <host>/threads/<uuid>; thread ids are kept across instances
 *     staff          true: the actor acted as the host's instance staff (metadata.staff,
 *                    migration 20261027250001), not as a moderator of the server
 *
 * A member instance stores the Note as a system row, the actor ids mapped back to its own
 * profiles. Only the Group hosting the channel speaks for it: the channel collection the
 * member instance fetches from that Group, or a Create whose actor is that Group.
 */

import { escapeHtml } from '../utils/html.js';

export const HARMONY_SYSTEM = 'harmony:system';

export const SYSTEM_NOTE_TYPES: ReadonlySet<string> = new Set([
  'member_join',
  'member_leave',
  'member_kick',
  'member_ban',
  'thread_created',
  'channel_encryption_enabled',
  'channel_encryption_disabled',
  'channel_voice_encryption_enabled',
  'channel_voice_encryption_disabled',
]);

/** Delivered live by the Group; mirrors trigger_queue_channel_message_federation. */
export const LIVE_SYSTEM_NOTE_TYPES: ReadonlySet<string> = new Set([
  'member_join',
  'member_leave',
  'member_kick',
  'member_ban',
]);

const MAX_URL = 2048;
const MAX_NAME = 100;
const MAX_REASON = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HarmonySystem {
  type: string;
  subject?: string;
  actor?: string;
  actorName?: string;
  reason?: string;
  thread?: string;
  threadName?: string;
  staff?: true;
}

export interface SystemProfile {
  id: string;
  username?: string | null;
  display_name?: string | null;
  federated_id?: string | null;
}

export interface SystemBot {
  id: string;
  username?: string | null;
  display_name?: string | null;
}

export interface SystemPeople {
  profiles: Map<string, SystemProfile>;
  bots: Map<string, SystemBot>;
}

export interface SystemRow {
  id: string;
  content?: unknown;
  metadata?: Record<string, any> | null;
  created_at: string;
  updated_at?: string | null;
}

function uuidOf(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/** Profile and bot ids named by system rows. */
export function systemPeopleIds(rows: SystemRow[]): { profileIds: string[]; botIds: string[] } {
  const profileIds = new Set<string>();
  const botIds = new Set<string>();
  for (const row of rows) {
    const meta = row.metadata || {};
    for (const id of [uuidOf(meta.subject_id), uuidOf(meta.actor_id)]) {
      if (id) profileIds.add(id);
    }
    const bot = uuidOf(meta.actor_bot_id);
    if (bot) botIds.add(bot);
  }
  return { profileIds: [...profileIds], botIds: [...botIds] };
}

/** Profiles and bots named by system rows, read with the service role. */
export async function loadSystemPeople(supabase: any, rows: SystemRow[]): Promise<SystemPeople> {
  const { profileIds, botIds } = systemPeopleIds(rows);
  const people: SystemPeople = { profiles: new Map(), bots: new Map() };
  if (profileIds.length > 0) {
    const { data } = await supabase
      .from('profiles')
      .select('id, username, display_name, federated_id')
      .in('id', profileIds);
    for (const p of data || []) people.profiles.set(p.id, p);
  }
  if (botIds.length > 0) {
    const { data } = await supabase
      .from('bots')
      .select('id, username, display_name')
      .in('id', botIds);
    for (const b of data || []) people.bots.set(b.id, b);
  }
  return people;
}

/** Actor id of a profile: a remote profile's own, a local one's on this host. */
export function profileActorId(profile: SystemProfile, hostDomain: string): string | undefined {
  if (profile.federated_id) return profile.federated_id;
  return profile.username ? `https://${hostDomain}/users/${profile.username}` : undefined;
}

function nameOf(profile: SystemProfile | SystemBot | undefined): string | undefined {
  const name = profile?.display_name?.trim() || profile?.username?.trim();
  return name ? name.slice(0, MAX_NAME) : undefined;
}

/** Name of the actor that has no profile: a Discord member, then a bot. */
function actorNameOf(meta: Record<string, any>, people: SystemPeople): string | undefined {
  const discord = meta.discord_user;
  const discordName = typeof discord?.display_name === 'string' && discord.display_name.trim()
    ? discord.display_name
    : typeof discord?.username === 'string' ? discord.username : undefined;
  if (discordName?.trim()) return discordName.trim().slice(0, MAX_NAME);
  const bot = uuidOf(meta.actor_bot_id);
  return bot ? nameOf(people.bots.get(bot)) : undefined;
}

/** `harmony:system` of a system row, or null for a type that does not federate. */
export function toHarmonySystem(
  metadata: Record<string, any> | null | undefined,
  people: SystemPeople,
  hostDomain: string,
): HarmonySystem | null {
  const meta = metadata || {};
  if (typeof meta.type !== 'string' || !SYSTEM_NOTE_TYPES.has(meta.type)) return null;
  const sys: HarmonySystem = { type: meta.type };

  const subject = uuidOf(meta.subject_id);
  const subjectProfile = subject ? people.profiles.get(subject) : undefined;
  const subjectUrl = subjectProfile ? profileActorId(subjectProfile, hostDomain) : undefined;
  if (subjectUrl) sys.subject = subjectUrl;

  const actor = uuidOf(meta.actor_id);
  const actorProfile = actor ? people.profiles.get(actor) : undefined;
  const actorUrl = actorProfile ? profileActorId(actorProfile, hostDomain) : undefined;
  if (actorUrl) {
    sys.actor = actorUrl;
  } else {
    const actorName = actorNameOf(meta, people);
    if (actorName) sys.actorName = actorName;
  }

  if (typeof meta.reason === 'string' && meta.reason) sys.reason = meta.reason.slice(0, MAX_REASON);
  const thread = uuidOf(meta.thread_id);
  if (thread) sys.thread = `https://${hostDomain}/threads/${thread}`;
  if (typeof meta.thread_name === 'string' && meta.thread_name) sys.threadName = meta.thread_name.slice(0, MAX_NAME);
  if (meta.staff === true) sys.staff = true;
  return sys;
}

/**
 * English text of a notice, the Note's content for readers without `harmony:system`.
 * Names are the profiles' current ones.
 */
export function systemNoteText(
  metadata: Record<string, any> | null | undefined,
  people: SystemPeople,
  hostDomain?: string,
): string {
  const meta = metadata || {};
  const subject = uuidOf(meta.subject_id);
  const actor = uuidOf(meta.actor_id);
  const subjectName = (subject && nameOf(people.profiles.get(subject))) || 'Someone';
  const staff = meta.staff === true && hostDomain ? ` (${hostDomain} staff)` : '';
  const actorName = ((actor && nameOf(people.profiles.get(actor))) || actorNameOf(meta, people) || 'Someone') + staff;
  const reason = typeof meta.reason === 'string' && meta.reason ? `: ${meta.reason.slice(0, MAX_REASON)}` : '';
  const threadName = typeof meta.thread_name === 'string' && meta.thread_name ? meta.thread_name : 'a thread';

  switch (meta.type) {
    case 'member_join':
      return `${subjectName} joined the server`;
    case 'member_leave':
      return `${subjectName} left the server`;
    case 'member_kick':
      return actor ? `${subjectName} was kicked by ${actorName}${reason}` : `${subjectName} was kicked${reason}`;
    case 'member_ban':
      return actor ? `${subjectName} was banned by ${actorName}${reason}` : `${subjectName} was banned${reason}`;
    case 'thread_created':
      return `${actorName} started a thread: ${threadName}`;
    case 'channel_encryption_enabled':
      return `${actorName} turned on end-to-end encryption`;
    case 'channel_encryption_disabled':
      return `${actorName} turned off end-to-end encryption`;
    case 'channel_voice_encryption_enabled':
      return `${actorName} turned on end-to-end encryption for voice and video`;
    case 'channel_voice_encryption_disabled':
      return `${actorName} turned off end-to-end encryption for voice and video`;
    default:
      return 'System notice';
  }
}

/**
 * Note of a system row in a channel of a local server. `content` is plain text for the
 * channel collection, whose other items are plain text, and HTML for activities.
 */
export function systemNote(
  row: SystemRow,
  options: {
    hostDomain: string;
    serverId: string;
    channelId: string;
    people: SystemPeople;
    html?: boolean;
  },
): Record<string, any> | null {
  const sys = toHarmonySystem(row.metadata, options.people, options.hostDomain);
  if (!sys) return null;
  const serverUrl = `https://${options.hostDomain}/servers/${options.serverId}`;
  const text = systemNoteText(row.metadata, options.people, options.hostDomain);
  return {
    type: 'Note',
    id: `https://${options.hostDomain}/messages/${row.id}`,
    attributedTo: serverUrl,
    content: options.html ? `<p>${escapeHtml(text)}</p>` : text,
    context: `${serverUrl}/channels/${options.channelId}`,
    published: row.created_at,
    [HARMONY_SYSTEM]: sys,
  };
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

/** `harmony:system` of an inbound Note, or null when absent or malformed. */
export function parseHarmonySystem(value: unknown): HarmonySystem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string' || !SYSTEM_NOTE_TYPES.has(v.type)) return null;
  const sys: HarmonySystem = { type: v.type };
  const subject = httpUrl(v.subject);
  const actor = httpUrl(v.actor);
  const thread = httpUrl(v.thread);
  const actorName = boundedText(v.actorName, MAX_NAME);
  const reason = boundedText(v.reason, MAX_REASON);
  const threadName = boundedText(v.threadName, MAX_NAME);
  if (subject) sys.subject = subject;
  if (actor) sys.actor = actor;
  if (actorName) sys.actorName = actorName;
  if (reason) sys.reason = reason;
  if (thread) sys.thread = thread;
  if (threadName) sys.threadName = threadName;
  if (v.staff === true) sys.staff = true;
  return sys;
}

/** Actor ids a parsed notice names, to resolve to profiles. */
export function systemActorUrls(sys: HarmonySystem): string[] {
  return [sys.subject, sys.actor].filter((u): u is string => !!u);
}

/**
 * metadata of the local system row for a parsed notice. `profileIdOf` maps an actor id
 * to a local profile id; an actor id it cannot map is dropped, and an unmapped actor
 * falls back to actor_name.
 */
export function systemMetadata(
  sys: HarmonySystem,
  profileIdOf: (actorUrl: string) => string | null | undefined,
): Record<string, unknown> {
  const meta: Record<string, unknown> = { type: sys.type };
  const subjectId = sys.subject ? profileIdOf(sys.subject) : null;
  if (subjectId) meta.subject_id = subjectId;
  const actorId = sys.actor ? profileIdOf(sys.actor) : null;
  if (actorId) meta.actor_id = actorId;
  else if (sys.actorName) meta.actor_name = sys.actorName;
  if (sys.reason) meta.reason = sys.reason;
  const threadId = sys.thread?.match(/\/threads\/([0-9a-f-]{36})$/i)?.[1];
  if (threadId && UUID.test(threadId)) meta.thread_id = threadId.toLowerCase();
  if (sys.threadName) meta.thread_name = sys.threadName;
  if (sys.staff) meta.staff = true;
  return meta;
}

/** Plain text of a Note's HTML content, for the stored row's content. */
export function noteContentText(content: unknown): string {
  if (typeof content !== 'string') return '';
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
