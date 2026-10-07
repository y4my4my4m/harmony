import { describe, expect, it } from 'vitest';
import { buildVoiceMenu, placePopover, type VoiceMenuInput } from '../voiceMenuModel';

const remote: VoiceMenuInput = {
  isSelf: false,
  source: 'camera',
  isStreaming: false,
  hasCamera: false,
  canWatch: true,
  watching: false,
  isFocused: false,
  isPoppedOut: false,
  canFullscreen: true,
};

describe('buildVoiceMenu', () => {
  it('offers only mic volume for a voice-only user', () => {
    const m = buildVoiceMenu(remote);
    expect(m.volumes).toEqual(['mic']);
    expect(m.actions).toEqual([]);
    expect(m.showQuality).toBe(false);
  });

  it('offers mic and stream volume for a streamer, stream first from the stream tile', () => {
    expect(buildVoiceMenu({ ...remote, isStreaming: true }).volumes).toEqual(['mic', 'screen']);
    expect(buildVoiceMenu({ ...remote, isStreaming: true, source: 'screen' }).volumes).toEqual(['screen', 'mic']);
  });

  it('asks to watch an unwatched stream and hides view actions for it', () => {
    const m = buildVoiceMenu({ ...remote, isStreaming: true });
    expect(m.actions).toEqual(['watch']);
  });

  it('gives a watched stream stop watching, focus, full screen and pop out', () => {
    const m = buildVoiceMenu({ ...remote, isStreaming: true, watching: true });
    expect(m.actions).toEqual(['stop-watching', 'focus', 'fullscreen', 'pop-out']);
  });

  it('reflects focus and pop-out state', () => {
    const m = buildVoiceMenu({ ...remote, isStreaming: true, watching: true, isFocused: true, isPoppedOut: true });
    expect(m.actions).toEqual(['stop-watching', 'exit-focus', 'fullscreen', 'close-pop-out']);
  });

  it('drops full screen where the host cannot do it', () => {
    const m = buildVoiceMenu({ ...remote, hasCamera: true, canFullscreen: false });
    expect(m.actions).toEqual(['focus']);
  });

  it('treats streams as always received without opt-in (P2P)', () => {
    const m = buildVoiceMenu({ ...remote, isStreaming: true, canWatch: false });
    expect(m.actions).toEqual(['focus', 'fullscreen', 'pop-out']);
  });

  it('gives the sharer quality, stop streaming, mute and deafen', () => {
    const m = buildVoiceMenu({ ...remote, isSelf: true, isStreaming: true });
    expect(m.volumes).toEqual([]);
    expect(m.showQuality).toBe(true);
    expect(m.actions).toEqual(['stop-streaming', 'focus', 'self-mute', 'self-deafen']);
  });

  it('gives self without media only mute and deafen', () => {
    const m = buildVoiceMenu({ ...remote, isSelf: true });
    expect(m.showQuality).toBe(false);
    expect(m.actions).toEqual(['self-mute', 'self-deafen']);
  });
});

describe('placePopover', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 300, height: 200 };

  it('opens down-right of a click with room', () => {
    expect(placePopover({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 });
  });

  it('flips left and clamps up near the bottom-right corner', () => {
    expect(placePopover({ x: 900, y: 750 }, size, viewport)).toEqual({ x: 600, y: 592 });
  });

  it('opens above a button with room, centred', () => {
    const anchor = { left: 450, top: 700, width: 100, height: 40 };
    expect(placePopover(anchor, size, viewport)).toEqual({ x: 350, y: 492 });
  });

  it('opens below a button near the top', () => {
    const anchor = { left: 450, top: 20, width: 100, height: 40 };
    expect(placePopover(anchor, size, viewport)).toEqual({ x: 350, y: 68 });
  });

  it('keeps an oversized popover at the margin', () => {
    expect(placePopover({ x: 50, y: 50 }, { width: 2000, height: 2000 }, viewport)).toEqual({ x: 8, y: 8 });
  });
});
