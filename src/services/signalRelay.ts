/**
 * Signals on harmony-voice-<room>, dm-call:<conversation> and easter-egg:<room> go through
 * send_signal (20261124100001_call_signal_relay.sql), which broadcasts them with the caller as the
 * sender; those topics take no client broadcast. An instance without it (capability signal-relay
 * absent) takes the client's own broadcast instead.
 */

import { supabase } from '@/supabase';
import { hasCapability } from '@/services/instanceCapabilities';

export type SignalTopic = `harmony-voice-${string}` | `dm-call:${string}` | `easter-egg:${string}`;

export function relaysSignals(): boolean {
  return hasCapability('signal-relay');
}

/**
 * Sends one signal: through send_signal, or by `broadcast` on an instance without it. Throws the
 * refusal (PostgREST error: rate limit, access, shape) or what `broadcast` throws.
 */
export async function sendSignal(
  topic: SignalTopic,
  event: string,
  payload: Record<string, unknown>,
  broadcast: () => unknown,
): Promise<void> {
  if (!relaysSignals()) {
    await broadcast();
    return;
  }
  const { error } = await supabase.rpc('send_signal', { p_topic: topic, p_event: event, p_payload: payload });
  if (error) throw error;
}
