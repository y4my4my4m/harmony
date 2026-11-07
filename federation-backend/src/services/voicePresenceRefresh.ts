/**
 * Re-announces this instance's voice callers to the Harmony 1.9.4+ instances holding copies
 * of its servers. A copy drops a caller's row 30 minutes after the last announcement
 * (sweep_stale_voice_participants, 20261108100001); a VoiceChannelJoin marked harmony:refresh
 * every PRESENCE_REFRESH_MS restamps live callers' rows there and creates none, so a lost
 * VoiceChannelLeave lists a departed caller for at most 30 minutes and a late refresh lists
 * nobody.
 *
 * One voice_presence_refresh_targets call per run returns every (caller, instance) pair;
 * each caller's activity is built once and delivered once to each of its instances
 * (DeliveryQueue.deliverOnce). A failed delivery is not queued: the next run replaces it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { VoiceActivityHandler } from '../activitypub/VoiceActivityHandler.js';
import { federationSwitches } from './FederationSwitches.js';
import { voiceRosterUnverified } from './voiceParticipantSweep.js';

export const PRESENCE_REFRESH_MS = 10 * 60_000;

interface Target {
  channel_id: string;
  channel_name: string | null;
  server_id: string;
  server_name: string | null;
  user_id: string;
  username: string | null;
  federated_id: string | null;
  instance: string | null;
  shared_inbox: string | null;
}

export interface RefreshDeps {
  supabase: Pick<SupabaseClient, 'rpc'>;
  instanceDomain: string;
  deliver: (items: Array<{ inbox: string; activity: unknown }>, signer: string) => Promise<void>;
}

export type RefreshResult =
  | { ok: true; callers: number; deliveries: number }
  | { ok: false; reason: string };

export async function refreshVoicePresence(deps: RefreshDeps): Promise<RefreshResult> {
  const { data, error } = await deps.supabase.rpc('voice_presence_refresh_targets');
  if (error) return { ok: false, reason: error.message };

  const host = deps.instanceDomain.toLowerCase();
  const callers = new Map<string, { userId: string; activity: unknown; inboxes: Set<string> }>();
  for (const t of (data ?? []) as Target[]) {
    if (!t.instance || t.instance === host) continue;
    if (!t.federated_id && !t.username) continue;
    const key = `${t.channel_id}|${t.user_id}`;
    let caller = callers.get(key);
    if (!caller) {
      const actor = t.federated_id || `https://${deps.instanceDomain}/users/${t.username}`;
      caller = {
        userId: t.user_id,
        activity: {
          ...VoiceActivityHandler.createVoiceChannelJoin(
            actor, t.channel_id, t.channel_name ?? '', t.server_id, t.server_name ?? '',
          ),
          'harmony:refresh': true,
        },
        inboxes: new Set(),
      };
      callers.set(key, caller);
    }
    caller.inboxes.add(t.shared_inbox || `https://${t.instance}/inbox`);
  }

  let deliveries = 0;
  for (const caller of callers.values()) {
    const items = [...caller.inboxes].map((inbox) => ({ inbox, activity: caller.activity }));
    deliveries += items.length;
    await deps.deliver(items, caller.userId);
  }
  return { ok: true, callers: callers.size, deliveries };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!(await federationSwitches()).outbound) return;
    // Rows the reconciliation could not check are not re-announced.
    if (voiceRosterUnverified()) {
      logger.warn('Voice presence refresh skipped: LiveKit reconciliation is failing');
      return;
    }
    const result = await refreshVoicePresence({
      supabase: getSupabaseClient(),
      instanceDomain: config.INSTANCE_DOMAIN,
      deliver: async (items, signer) => {
        await Promise.all(items.map((item) => DeliveryQueue.deliverOnce(item.activity, item.inbox, signer)))
      },
    });
    if (!result.ok) logger.warn(`Voice presence refresh failed: ${result.reason}`);
    else if (result.deliveries > 0) {
      logger.info(`Voice presence refreshed: ${result.callers} caller(s), ${result.deliveries} delivery(ies)`);
    }
  } catch (error) {
    logger.error('Voice presence refresh failed:', error);
  } finally {
    running = false;
  }
}

export function startVoicePresenceRefresh(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PRESENCE_REFRESH_MS);
  logger.info(`Voice presence refresh started (${PRESENCE_REFRESH_MS / 1000}s interval)`);
}

export function stopVoicePresenceRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
