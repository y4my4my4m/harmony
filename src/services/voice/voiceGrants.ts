/**
 * What a voice participant may do, as the server decides it
 * (federation-backend voiceGrants.ts): the LiveKit permission of the token or
 * of the last moderation change, and the moderation flags in the participant
 * metadata.
 */

/** @livekit/protocol TrackSource. */
const SOURCE_MICROPHONE = 2;
const SOURCE_SCREEN_SHARE = 3;

export interface VoiceGrants {
  /** Microphone: SPEAK, not server-muted or deafened. */
  speak: boolean;
  /** Camera and screen share: STREAM. */
  stream: boolean;
  /** Others' tracks: not server-deafened. */
  hear: boolean;
}

export const OPEN_GRANTS: VoiceGrants = { speak: true, stream: true, hear: true };

export interface ModerationFlags {
  muted: boolean;
  deafened: boolean;
}

/** A LiveKit ParticipantPermission. An empty source list with canPublish allows every source. */
export function grantsFromPermission(permission?: {
  canPublish?: boolean;
  canPublishSources?: number[];
  canSubscribe?: boolean;
} | null): VoiceGrants {
  if (!permission) return OPEN_GRANTS;
  const sources = permission.canPublishSources ?? [];
  const allows = (source: number) => !!permission.canPublish && (sources.length === 0 || sources.includes(source));
  return {
    speak: allows(SOURCE_MICROPHONE),
    stream: allows(SOURCE_SCREEN_SHARE),
    hear: permission.canSubscribe !== false,
  };
}

/** serverMuted and serverDeafened of participant metadata; false when absent or unreadable. */
export function moderationFromMetadata(metadata: string | undefined | null): ModerationFlags {
  if (!metadata) return { muted: false, deafened: false };
  try {
    const parsed = JSON.parse(metadata);
    return { muted: parsed?.serverMuted === true, deafened: parsed?.serverDeafened === true };
  } catch {
    return { muted: false, deafened: false };
  }
}

/** get_user_permissions of the caller in the channel, for the P2P transport. */
export function grantsFromRolePermissions(perms: Partial<Record<string, boolean>>): VoiceGrants {
  const admin = perms.ADMINISTRATOR === true;
  return {
    speak: admin || perms.SPEAK === true,
    stream: admin || perms.STREAM === true,
    hear: true,
  };
}
