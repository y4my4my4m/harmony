/**
 * ap_activities.ap_id is the inbox dedupe key, and the sender picks it. A row under another
 * actor's id makes that actor's real delivery read as already processed.
 *
 * An id off the actor's host is not stored, and a stored row of another actor on the same host
 * is no duplicate. Either way the activity runs unclaimed: authorization still applies, only
 * redelivery protection is absent. Forwarded activities are confirmed by their origin first
 * (forwardedActivity.ts), so `actorUrl` is the origin's actor.
 */

import { sameOrigin } from '../utils/apOrigin.js';
import { SignatureService } from './SignatureService.js';

export function activityIdIsStorable(activityId: unknown, actorUrl: unknown): boolean {
  return sameOrigin(activityId, actorUrl);
}

export async function activityIdHeldByAnother(supabase: any, activityId: string, actorUrl: string): Promise<boolean> {
  const { data } = await supabase
    .from('ap_activities')
    .select('actor_ap_id')
    .eq('ap_id', activityId)
    .maybeSingle();
  return !!data?.actor_ap_id && !SignatureService.verifyActorMatch(actorUrl, data.actor_ap_id);
}
