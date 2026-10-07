/**
 * Runs reconcileVoiceParticipants against this instance's LiveKit: every
 * VOICE_RECONCILE_INTERVAL_SECONDS in the worker, and for one room on a
 * LiveKit webhook in the server.
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { livekitService } from './LiveKitService.js';
import {
  reconcileVoiceParticipants,
  type Departure,
  type ReconcileResult,
} from './voiceParticipantReconciler.js';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Off when LiveKit is not configured or clients never use it (WEBRTC_MODE=p2p). */
export function voiceReconcileEnabled(): boolean {
  return livekitService.isConfigured() && config.WEBRTC_MODE !== 'p2p';
}

export async function reconcileVoiceNow(
  scope: { channelIds?: string[]; departure?: Departure } = {},
): Promise<ReconcileResult> {
  if (!voiceReconcileEnabled()) return { ok: false, reason: 'LiveKit reconciliation is off' };
  return reconcileVoiceParticipants({
    roomService: livekitService.roomServiceClient(),
    supabase: getSupabaseClient(),
    instanceDomain: config.INSTANCE_DOMAIN,
    ...scope,
  });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await reconcileVoiceNow();
    if (!result.ok) logger.warn(`Voice participant sweep skipped: ${result.reason}`);
    else if (result.removed > 0) logger.info(`Voice participant sweep removed ${result.removed} of ${result.checked} rows`);
  } catch (error) {
    logger.error('Voice participant sweep failed:', error);
  } finally {
    running = false;
  }
}

/** First run is immediate. */
export function startVoiceParticipantSweep(): void {
  if (timer) return;
  const seconds = config.VOICE_RECONCILE_INTERVAL_SECONDS;
  if (seconds <= 0 || !voiceReconcileEnabled()) {
    logger.info('Voice participant sweep off');
    return;
  }
  void tick();
  timer = setInterval(() => void tick(), seconds * 1000);
  logger.info(`Voice participant sweep started (${seconds}s interval)`);
}

export function stopVoiceParticipantSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
