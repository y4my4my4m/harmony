import type { AdaptiveStreamSettings } from 'livekit-client'

/**
 * Passed as Room `adaptiveStream`. Each RemoteVideoTrack keeps this object and
 * reads pauseVideoInBackground at every visibility change, so a change here
 * applies to tracks already subscribed. Unset means LiveKit's default (pause).
 */
export const adaptiveStreamSettings: AdaptiveStreamSettings = {}

/** False keeps remote video flowing while the main document is hidden. */
export function setPauseVideoInBackground(pause: boolean): void {
  if (pause) delete adaptiveStreamSettings.pauseVideoInBackground
  else adaptiveStreamSettings.pauseVideoInBackground = false
}
