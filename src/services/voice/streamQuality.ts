/**
 * Stream (screen share) quality presets and encoder budgets.
 *
 * Resolution is the frame height in pixels; -1 is source (the captured
 * surface's native size, uncapped).
 */

export const SOURCE_RESOLUTION = -1;

export interface StreamQuality {
  resolution: number;
  frameRate: number;
}

export interface StreamQualityPreset extends StreamQuality {
  id: string;
}

export const STREAM_QUALITY_PRESETS: readonly StreamQualityPreset[] = [
  { id: '720p30', resolution: 720, frameRate: 30 },
  { id: '720p60', resolution: 720, frameRate: 60 },
  { id: '1080p30', resolution: 1080, frameRate: 30 },
  { id: '1080p60', resolution: 1080, frameRate: 60 },
  { id: 'source30', resolution: SOURCE_RESOLUTION, frameRate: 30 },
  { id: 'source60', resolution: SOURCE_RESOLUTION, frameRate: 60 },
];

/** Stream settings a caller may change; omitted fields keep their value. */
export interface StreamSettingsUpdate {
  resolution?: number;
  frameRate?: number;
  /** kbps. */
  audioBitrate?: number;
  /** Desktop app: capture program audio natively with the stream. */
  shareAudio?: boolean;
}

/** Stream audio bitrates offered to the sharer, kbps. */
export const STREAM_AUDIO_BITRATES: readonly number[] = [64, 96, 128, 192, 256];
export const DEFAULT_STREAM_AUDIO_BITRATE = 128;

export function findPreset(quality: StreamQuality): StreamQualityPreset | null {
  return STREAM_QUALITY_PRESETS.find(
    p => p.resolution === quality.resolution && p.frameRate === quality.frameRate,
  ) ?? null;
}

/** '720p', '1080p', 'Source' ... for a resolution value. */
export function resolutionLabel(resolution: number): string {
  if (resolution === SOURCE_RESOLUTION) return 'Source';
  if (resolution === 2160) return '4K';
  return `${resolution}p`;
}

export function qualityLabel(quality: StreamQuality): string {
  return `${resolutionLabel(quality.resolution)} ${quality.frameRate} fps`;
}

/**
 * getDisplayMedia size hint. Source maps to 0x0, which livekit-client's
 * screenCaptureToDisplayMediaStreamOptions treats as uncapped.
 */
export function screenCaptureResolution(quality: StreamQuality): { width: number; height: number; frameRate: number } {
  if (quality.resolution === SOURCE_RESOLUTION || quality.resolution <= 0) {
    return { width: 0, height: 0, frameRate: quality.frameRate };
  }
  return {
    width: Math.round(quality.resolution * 16 / 9),
    height: quality.resolution,
    frameRate: quality.frameRate,
  };
}

/**
 * Screen share encoder ceiling, bits per second. 3 Mbps at 1080p starved
 * 60 fps (frames were dropped to fit); the ladder scales with height and
 * framerate.
 */
export function screenShareBitrate(height: number, frameRate: number): number {
  const base =
    height >= 2160 ? 16_000_000 :
    height >= 1440 ? 8_000_000 :
    height >= 1080 ? 5_000_000 :
    height >= 720 ? 2_500_000 :
    1_200_000;
  const fpsScale = frameRate >= 60 ? 1.8 : frameRate >= 48 ? 1.4 : 1;
  return Math.round(base * fpsScale);
}

/**
 * Capture constraints applied to a live screen track. applyConstraints
 * replaces the whole set, so source omits width and height to lift an
 * earlier cap.
 */
export function liveScreenConstraints(quality: StreamQuality): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    frameRate: { ideal: quality.frameRate, max: quality.frameRate },
  };
  if (quality.resolution !== SOURCE_RESOLUTION && quality.resolution > 0) {
    constraints.height = { ideal: quality.resolution };
    constraints.width = { ideal: Math.round(quality.resolution * 16 / 9) };
  }
  return constraints;
}
