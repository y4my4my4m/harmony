/**
 * A queued delivery whose activity is built when each attempt is sent, from the reactor's
 * state at that moment. Misskey-family inboxes hold one reaction per actor, so a retry of
 * an activity built earlier can overwrite a newer state.
 */

export const DEFERRED_ENGAGEMENT_TYPE = 'harmony:DeferredEngagement';

export interface DeferredEngagement {
  type: typeof DEFERRED_ENGAGEMENT_TYPE;
  post_id: string;
  user_id: string;
  username: string;
  post_ap_id: string;
  /** URL host of the inbox; an emoji native to it is sent as `:name:`. */
  target_host?: string;
  to?: string[];
  /** A deleted favourite; its Undo is sent when the reactor holds neither favourite nor reaction. */
  undo_favourite_id?: string;
}

export function isDeferredEngagement(activity: unknown): activity is DeferredEngagement {
  return !!activity && typeof activity === 'object'
    && (activity as { type?: unknown }).type === DEFERRED_ENGAGEMENT_TYPE;
}
