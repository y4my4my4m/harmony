// LiveKit config and tokens; URLs stay backend-relative
import { supabase } from '@/supabase';
import { apiUrl } from '@/services/instanceConfig';

export interface LiveKitConfig {
  enabled: boolean;
  mode: 'sfu' | 'p2p' | 'hybrid';
  wsUrl: string | null;
  allowFederatedVoice: boolean;
}

export interface TokenResponse {
  token: string;
  wsUrl: string;
  roomName: string;
  identity: string;
}

export type LiveKitRoomType = 'voice_channel' | 'dm_call' | 'stage';

let configCache: LiveKitConfig | null = null;

/** The instance's voice config, fetched now; null when the request fails. */
export async function fetchLiveKitConfig(): Promise<LiveKitConfig | null> {
  try {
    const response = await fetch(apiUrl('/api/livekit/config'));
    if (!response.ok) return null;

    const config = await response.json();
    configCache = {
      enabled: config.enabled ?? false,
      mode: config.mode ?? 'hybrid',
      wsUrl: config.wsUrl ?? null,
      allowFederatedVoice: config.allowFederatedVoice ?? true,
    };
    return configCache;
  } catch {
    return null;
  }
}

/** Last config fetched successfully in this session, whatever its age. */
export function lastLiveKitConfig(): LiveKitConfig | null {
  return configCache;
}

export function liveKitRoomName(channelId: string, roomType: LiveKitRoomType): string {
  return roomType === 'dm_call' ? channelId : `channel-${channelId}`;
}

export async function getLiveKitToken(
  roomName: string,
  roomType: LiveKitRoomType
): Promise<TokenResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('User not authenticated');
  }

  const response = await fetch(apiUrl('/api/livekit/token'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      roomName,
      roomType,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || 'Failed to get room token');
  }

  return response.json();
}
