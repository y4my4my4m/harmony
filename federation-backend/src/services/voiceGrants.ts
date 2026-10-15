/**
 * LiveKit permissions of a voice room participant, from its VoiceGrants
 * (authorizeVoiceChannel).
 *
 *   microphone                          canSpeak: SPEAK, not server-muted or deafened
 *   camera, screen_share,
 *   screen_share_audio                  canStream: STREAM (Discord's "Video")
 *   subscribe                           canHear: not server-deafened
 *   data                                always
 *
 * canPublishSources supersedes canPublish, and an empty list allows every
 * source, so a participant with no source gets canPublish false and no list.
 *
 * Participant metadata carries soundboard, soundboardExternal, serverMuted and
 * serverDeafened. Listeners drop soundboard plays the sender's metadata
 * withholds; clients show the moderation flags.
 */

import { TrackSource, type ParticipantPermission, type VideoGrant } from 'livekit-server-sdk';
import type { RoomType, VoiceGrants } from './voiceAccess.js';

const STREAM_SOURCES = [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

export function publishSources(grants: VoiceGrants): TrackSource[] {
  const sources: TrackSource[] = [];
  if (grants.canSpeak) sources.push(TrackSource.MICROPHONE);
  if (grants.canStream) sources.push(...STREAM_SOURCES);
  return sources;
}

/**
 * Token grant for a room. The request may narrow, never widen: a stage room
 * publishes only when asked to.
 */
export function liveKitGrant(
  request: { roomName: string; roomType: RoomType; canPublish?: boolean; canSubscribe?: boolean; canPublishData?: boolean },
  grants: VoiceGrants,
): VideoGrant {
  const wantsPublish = request.canPublish ?? request.roomType !== 'stage';
  const sources = wantsPublish ? publishSources(grants) : [];
  return {
    roomJoin: true,
    room: request.roomName,
    canPublish: sources.length > 0,
    ...(sources.length > 0 ? { canPublishSources: sources } : {}),
    canSubscribe: (request.canSubscribe ?? true) && grants.canHear,
    canPublishData: request.canPublishData ?? true,
  };
}

export function voiceMetadataFlags(grants: VoiceGrants): {
  soundboard: boolean;
  soundboardExternal: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
} {
  return {
    soundboard: grants.canSoundboard,
    soundboardExternal: grants.canExternalSounds,
    serverMuted: grants.serverMuted,
    serverDeafened: grants.serverDeafened,
  };
}

/**
 * Permission of a connected participant. `current` is its permission now: in
 * a stage room only sources it already publishes stay allowed, so a listener
 * is not promoted by a moderation change.
 */
export function participantPermission(
  grants: VoiceGrants,
  stage: boolean,
  current?: { canPublish?: boolean; canPublishSources?: TrackSource[] } | null,
): Partial<ParticipantPermission> {
  let sources = publishSources(grants);
  if (stage) {
    const held = current?.canPublish
      ? (current.canPublishSources?.length ? current.canPublishSources : [TrackSource.MICROPHONE, ...STREAM_SOURCES])
      : [];
    sources = sources.filter((s) => held.includes(s));
  }
  return {
    canPublish: sources.length > 0,
    canPublishSources: sources,
    canSubscribe: grants.canHear,
    canPublishData: true,
  };
}

/** The participant's metadata with the grant flags replaced; other keys are kept. */
export function mergeVoiceMetadata(existing: string | undefined, grants: VoiceGrants): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
    } catch {
      // Not JSON: replaced.
    }
  }
  return JSON.stringify({ ...base, ...voiceMetadataFlags(grants) });
}
