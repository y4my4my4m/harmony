import { describe, expect, it } from 'vitest';
import {
  SOURCE_RESOLUTION,
  STREAM_QUALITY_PRESETS,
  findPreset,
  liveScreenConstraints,
  qualityLabel,
  resolutionLabel,
  screenCaptureResolution,
  screenShareBitrate,
} from '../streamQuality';

describe('stream quality presets', () => {
  it('offers the Discord ladder with unique ids', () => {
    const ids = STREAM_QUALITY_PRESETS.map(p => p.id);
    expect(ids).toEqual(['720p30', '720p60', '1080p30', '1080p60', 'source30', 'source60']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds the preset matching a setting', () => {
    expect(findPreset({ resolution: 1080, frameRate: 60 })?.id).toBe('1080p60');
    expect(findPreset({ resolution: SOURCE_RESOLUTION, frameRate: 30 })?.id).toBe('source30');
    expect(findPreset({ resolution: 480, frameRate: 30 })).toBeNull();
  });

  it('labels resolutions', () => {
    expect(resolutionLabel(720)).toBe('720p');
    expect(resolutionLabel(2160)).toBe('4K');
    expect(resolutionLabel(SOURCE_RESOLUTION)).toBe('Source');
    expect(qualityLabel({ resolution: 1080, frameRate: 60 })).toBe('1080p 60 fps');
  });
});

describe('screenCaptureResolution', () => {
  it('sizes a 16:9 capture hint', () => {
    expect(screenCaptureResolution({ resolution: 720, frameRate: 30 }))
      .toEqual({ width: 1280, height: 720, frameRate: 30 });
  });

  it('leaves source uncapped', () => {
    expect(screenCaptureResolution({ resolution: SOURCE_RESOLUTION, frameRate: 60 }))
      .toEqual({ width: 0, height: 0, frameRate: 60 });
  });
});

describe('screenShareBitrate', () => {
  it('scales with height', () => {
    expect(screenShareBitrate(720, 30)).toBe(2_500_000);
    expect(screenShareBitrate(1080, 30)).toBe(5_000_000);
    expect(screenShareBitrate(1440, 30)).toBe(8_000_000);
    expect(screenShareBitrate(480, 30)).toBe(1_200_000);
  });

  it('raises the ceiling for high framerates', () => {
    expect(screenShareBitrate(1080, 60)).toBe(9_000_000);
    expect(screenShareBitrate(1080, 50)).toBe(7_000_000);
  });
});

describe('liveScreenConstraints', () => {
  it('caps size and framerate for a fixed resolution', () => {
    expect(liveScreenConstraints({ resolution: 1080, frameRate: 30 })).toEqual({
      frameRate: { ideal: 30, max: 30 },
      height: { ideal: 1080 },
      width: { ideal: 1920 },
    });
  });

  it('omits size for source so an earlier cap is lifted', () => {
    const c = liveScreenConstraints({ resolution: SOURCE_RESOLUTION, frameRate: 60 });
    expect(c).toEqual({ frameRate: { ideal: 60, max: 60 } });
  });
});
