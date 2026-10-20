/**
 * FEP-1b12 Announce of an activity by a Group that is not a Harmony server. Lemmy, PieFed and
 * Mbin communities relay what their members post, comment and edit this way:
 *
 *   Announce { actor: <community>, object: Create { actor: <member>, object: Page | Note } }
 *
 * Lemmy also sends Announce { object: Page } of a new or edited post, for Mastodon; that one
 * is a boost (ActivityProcessor.processAnnounce). Guppe announces the Note itself.
 *
 * The Group's HTTP signature covers the Announce, not the member's activity. The inner
 * activity is processed as its origin serves it (confirmForwardedActivity): Create and Update
 * with the object fetched from its id on the member's host and attributed to the member, a
 * Delete once that host answers 404 or 410. An activity whose actor is the Group itself is
 * covered by its signature and taken as sent.
 *
 * Taken only from a Group a local account follows (accepted), and only Create, Update and
 * Delete. Votes (Like, Dislike), Undo, moderation (Remove, Block, Lock) and a Delete by a
 * moderator are dropped. A top-level post the Group relays reaches the Group's followers as
 * the Group's boost of it.
 */
import { sameUrl, urlHost } from '../utils/apOrigin.js';
import { confirmForwardedActivity, type ForwardDeps } from './forwardedActivity.js';

export const GROUP_ANNOUNCED_TYPES: ReadonlySet<string> = new Set(['Create', 'Update', 'Delete']);

export interface GroupAnnounceDeps extends ForwardDeps {
  /** Hosts this instance refuses content from. */
  isBlockedHost: (host: string) => boolean;
}

export type GroupAnnounceOutcome = { activity: any } | { refused: string } | { ignored: string };

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : null;
}

/** The activity to process for `groupUrl`'s Announce of an embedded activity. */
export async function unwrapGroupAnnounce(announce: any, groupUrl: string, deps: GroupAnnounceDeps): Promise<GroupAnnounceOutcome> {
  const inner = announce?.object;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return { refused: 'the Announce embeds no activity' };
  if (!GROUP_ANNOUNCED_TYPES.has(inner.type)) return { ignored: `${String(inner.type).slice(0, 64)} is not taken from a Group` };

  const actor = idOf(inner.actor);
  const host = urlHost(actor)?.replace(/:\d+$/, '');
  if (!actor || !host) return { refused: 'the inner activity names no actor' };
  if (deps.isBlockedHost(host)) return { refused: `${actor} is on a blocked instance` };

  if (sameUrl(actor, groupUrl)) return { activity: inner };

  const confirmed = await confirmForwardedActivity(inner, actor, deps);
  return 'refused' in confirmed ? { refused: `${inner.type} of ${actor}: ${confirmed.refused}` } : confirmed;
}

/** The post a relayed Create carries, when it is a top-level post the Group boosts. */
export function boostedTopLevelPost(activity: any): string | null {
  if (activity?.type !== 'Create') return null;
  const object = activity.object;
  if (!object || typeof object !== 'object' || object.inReplyTo) return null;
  return idOf(object);
}
