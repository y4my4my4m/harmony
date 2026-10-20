/**
 * Activities delivered by a signer other than their actor. Mastodon forwards a reply to the
 * followers of the account replied to, signed by that account
 * (ActivityPub::Activity::Create#forward_for_reply), and vouches for the body with the
 * author's Linked Data signature, which Harmony does not verify. The forwarded body is never
 * used: the claim is checked against the actor's own host and the copy that host serves is
 * processed instead.
 *
 * The activity id and the object must be on the actor's host.
 *
 *   - Create, Update: the object is fetched from its id, on the actor's host. Served at its
 *     own id, it must be attributed to the actor, or be the actor for an Update of an actor.
 *   - Announce: the activity is fetched from its id, on the actor's host; its actor must be
 *     the claimed actor.
 *   - Delete: the object, on the actor's host, must be gone there: 404 or 410 for a stored
 *     public or unlisted post, 410 for the actor itself. Followers-only posts, direct posts
 *     and channel messages are served to members only, so a 404 proves nothing for them.
 *
 * Nothing else is accepted from a forwarder.
 */
import type { FetchedDocument } from '../utils/apOrigin.js';
import { fetchAuthoritativeDocument, sameOrigin, sameUrl } from '../utils/apOrigin.js';

export const FORWARDABLE_TYPES: ReadonlySet<string> = new Set(['Create', 'Update', 'Announce', 'Delete']);

const ACTOR_TYPES = new Set(['Person', 'Service', 'Application', 'Organization', 'Group']);
const POST_TYPES = new Set(['Note', 'Article', 'Page', 'Video', 'Question']);

export interface ForwardDeps {
  fetchDoc: (url: string, onStatus?: (status: number) => void) => Promise<FetchedDocument | null>;
  /** Visibility of the stored post with this ap_id; null when none is stored. */
  storedPostVisibility: (apId: string) => Promise<string | null>;
}

export type ForwardOutcome = { activity: any } | { refused: string };

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : null;
}

/** The attributedTo of an object: a reference, or a list whose first actor entry counts. */
function attributedActor(object: any): string | null {
  const value = object?.attributedTo;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = idOf(entry);
      if (id && (typeof entry === 'string' || entry?.type === 'Person' || entry?.type === undefined)) return id;
    }
    return null;
  }
  return idOf(value);
}

/**
 * The activity to process in place of a forwarded one, built from what the actor's host
 * serves; `refused` names why there is none.
 */
export async function confirmForwardedActivity(activity: any, actorUrl: string, deps: ForwardDeps): Promise<ForwardOutcome> {
  const type = activity?.type;
  if (typeof type !== 'string' || !FORWARDABLE_TYPES.has(type)) return { refused: `${type} is not accepted forwarded` };

  if (type === 'Announce') {
    const id = idOf(activity);
    if (!id || !sameOrigin(id, actorUrl)) return { refused: 'Announce id is not on the actor\'s host' };
    const served = await fetchAuthoritativeDocument(id, (u) => deps.fetchDoc(u));
    if (!served || served.type !== 'Announce' || !sameUrl(served.id, id) || !sameUrl(idOf(served.actor), actorUrl)) {
      return { refused: 'the actor\'s host does not serve this Announce' };
    }
    // A boost names a post; an embedded activity is a Group relay, accepted only signed by the Group.
    if (typeof served.object !== 'string' && !POST_TYPES.has(served.object?.type)) {
      return { refused: 'the Announce does not name a post' };
    }
    return { activity: served };
  }

  if (!sameOrigin(idOf(activity), actorUrl)) return { refused: 'activity id is not on the actor\'s host' };
  const objectId = idOf(activity.object);
  if (!objectId || !sameOrigin(objectId, actorUrl)) return { refused: 'object is not on the actor\'s host' };

  if (type === 'Delete') {
    const isActor = sameUrl(objectId, actorUrl);
    const visibility = isActor ? null : await deps.storedPostVisibility(objectId);
    if (!isActor && visibility !== 'public' && visibility !== 'unlisted') {
      return { refused: 'no stored public post to delete' };
    }
    let status = 0;
    const served = await deps.fetchDoc(objectId, (s) => { status = s; });
    const gone = isActor ? status === 410 : status === 404 || status === 410;
    if (served || !gone) return { refused: `the actor's host answers ${status || 'nothing'} for the object` };
    return { activity: { id: activity.id, type: 'Delete', actor: actorUrl, object: objectId } };
  }

  const served = await fetchAuthoritativeDocument(objectId, (u) => deps.fetchDoc(u));
  if (!served || !sameUrl(served.id, objectId)) return { refused: 'the actor\'s host does not serve the object' };
  const owner = type === 'Update' && ACTOR_TYPES.has(served.type) ? served.id : attributedActor(served);
  if (!sameUrl(owner, actorUrl)) return { refused: 'the served object belongs to another actor' };

  return {
    activity: {
      '@context': activity['@context'] ?? 'https://www.w3.org/ns/activitystreams',
      id: activity.id,
      type,
      actor: actorUrl,
      object: served,
      to: served.to,
      cc: served.cc,
    },
  };
}
