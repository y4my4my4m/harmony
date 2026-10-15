/**
 * voice-grant-sync: a server's pending voice_grant_resyncs (voiceGrantSync.ts), against
 * LiveKit when voice runs there, presence rows alone otherwise.
 * federate-voice-moderation: a remote member's move, disconnect or server mute and deafen,
 * from the server's Group (voiceModerationFederation.ts).
 */

import config from '../../config/index.js';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { livekitService } from '../../services/LiveKitService.js';
import { syncVoiceGrants } from '../../services/voiceGrantSync.js';
import {
  handleVoiceModerationFederationJob,
  type VoiceModerationJob,
} from '../../activitypub/voiceModerationFederation.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleVoiceGrantSyncJob(data: FederationJobData): Promise<void> {
  const serverId = data.server_id;
  if (typeof serverId !== 'string') return;
  const liveKit = livekitService.isConfigured() && config.WEBRTC_MODE !== 'p2p';
  const result = await syncVoiceGrants({
    supabase: getSupabaseClient(),
    roomService: liveKit ? livekitService.roomServiceClient() : null,
  }, serverId);
  if (result.updated > 0 || result.removed > 0) {
    logger.info(`Voice grants of server ${serverId}: ${result.updated} updated, ${result.removed} removed of ${result.checked}`);
  }
}

export async function handleVoiceModerationJob(data: FederationJobData): Promise<void> {
  await handleVoiceModerationFederationJob(data as unknown as VoiceModerationJob & Record<string, unknown>);
}
