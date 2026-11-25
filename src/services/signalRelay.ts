/**
 * Signals on harmony-voice-<room>, dm-call:<conversation> and easter-egg:<room> go through
 * send_signal (20261124100001_call_signal_relay.sql), which broadcasts them with the caller as the
 * sender; those topics take no client broadcast. An instance without it takes the client's own
 * broadcast instead.
 *
 * The capability list of a native app dates from its start, and the instance may gain send_signal
 * while the app runs: without the capability the function is asked for, and one found absent is
 * asked for again ABSENT_MS later. Realtime does not answer a broadcast its send policy refuses, so
 * a broadcast that was not acknowledged (channel config broadcast.ack) also asks again.
 */

import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from '@/supabase';
import { hasCapability } from '@/services/instanceCapabilities';
import { currentMemberToken } from '@/services/realtimeMemberToken';
import { debug } from '@/utils/debug';

export type SignalTopic = `harmony-voice-${string}` | `dm-call:${string}` | `easter-egg:${string}`;

/** PostgREST: no function of that name and argument list in its schema cache. */
const MISSING_FUNCTION = 'PGRST202';
const ABSENT_MS = 10_000;
/** How long a broadcast waits for its acknowledgement, as RealtimeChannel.send's `timeout`. */
export const SIGNAL_ACK_TIMEOUT_MS = 5_000;

// send_signal answered although the capability is not listed.
let found = false;
let absentUntil = 0;

export function relaysSignals(): boolean {
  return found || hasCapability('signal-relay');
}

/** False when the instance has no send_signal. Throws its refusal. */
async function relay(topic: SignalTopic, event: string, payload: Record<string, unknown>): Promise<boolean> {
  const { error } = await supabase.rpc('send_signal', { p_topic: topic, p_event: event, p_payload: payload });
  if (error?.code === MISSING_FUNCTION) {
    found = false;
    absentUntil = Date.now() + ABSENT_MS;
    return false;
  }
  if (error) throw error;
  found = true;
  return true;
}

/** A broadcast's outcome: RealtimeChannel.send's 'ok', or nothing from a sender that does not report one. */
function taken(outcome: unknown): boolean {
  return outcome === undefined || outcome === 'ok';
}

/**
 * Sends one signal: through send_signal, or by `broadcast` on an instance without it. Throws the
 * refusal (PostgREST error: rate limit, access, shape), what `broadcast` throws, or an error when
 * the broadcast was not taken.
 */
export async function sendSignal(
  topic: SignalTopic,
  event: string,
  payload: Record<string, unknown>,
  broadcast: () => unknown,
): Promise<void> {
  const absent = !relaysSignals() && Date.now() < absentUntil;
  if (!absent && await relay(topic, event, payload)) return;
  const outcome = await broadcast();
  if (taken(outcome)) return;
  debug.warn('[Signals]', event, 'on', topic, 'was not taken as a broadcast:', outcome);
  if (absent && await relay(topic, event, payload)) return;
  throw new Error(`Signal not delivered: ${String(outcome)}`);
}

/**
 * One signal through send_signal from an unloading page: a keepalive request with the token Realtime
 * holds. supabase.rpc waits for auth-js's lock first, which such a page never gets.
 */
export function sendSignalOnUnload(topic: SignalTopic, event: string, payload: Record<string, unknown>): void {
  const token = currentMemberToken();
  if (!token) return;
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/send_signal`, {
      method: 'POST',
      keepalive: true,
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_topic: topic, p_event: event, p_payload: payload }),
    }).catch(() => {});
  } catch {
    // The other members drop this one once its connection has failed (unifiedWebRTC watchPeer).
  }
}
