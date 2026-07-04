// shared by the browser and native transports; URLs stay backend-relative
import { supabase } from '@/supabase';
import { apiUrl } from '@/services/instanceConfig';
import { debug } from '@/utils/debug';

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
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 60_000;

export async function getLiveKitConfig(forceRefresh = false): Promise<LiveKitConfig> {
  const now = Date.now();

  if (!forceRefresh && configCache && now - configCacheTime < CONFIG_CACHE_TTL) {
    return configCache;
  }

  try {
    const response = await fetch(apiUrl('/api/livekit/config'));

    if (!response.ok) {
      throw new Error('Failed to fetch LiveKit config');
    }

    const config = await response.json();

    configCache = {
      enabled: config.enabled ?? false,
      mode: config.mode ?? 'hybrid',
      wsUrl: config.wsUrl ?? null,
      allowFederatedVoice: config.allowFederatedVoice ?? true,
    };
    configCacheTime = now;

    return configCache;
  } catch {
    debug.warn('⚠️ Could not fetch LiveKit config, using defaults');

    return {
      enabled: false,
      mode: 'hybrid',
      wsUrl: null,
      allowFederatedVoice: true,
    };
  }
}

export async function isLiveKitAvailable(): Promise<boolean> {
  const config = await getLiveKitConfig();
  return config.enabled && !!config.wsUrl;
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

export async function getFederatedLiveKitToken(
  instanceUrl: string,
  actorId: string,
  roomName: string,
  roomType: LiveKitRoomType
): Promise<TokenResponse> {
  // TODO: Implement HTTP signature for federated requests
  const response = await fetch(`${instanceUrl}/api/livekit/federated-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      actorId,
      roomName,
      roomType,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || 'Failed to get federated token');
  }

  return response.json();
}
