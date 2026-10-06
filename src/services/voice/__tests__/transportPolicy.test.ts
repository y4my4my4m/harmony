import { describe, expect, it } from 'vitest';
import { selectCallTransport } from '../transportPolicy';
import type { LiveKitConfig } from '../../livekitTokens';

const config = (mode: LiveKitConfig['mode'], configured: boolean): LiveKitConfig => ({
  enabled: configured,
  mode,
  wsUrl: configured ? 'wss://livekit.example.test' : null,
  allowFederatedVoice: false,
});

const web = { native: false, requireE2EE: false };

describe('selectCallTransport', () => {
  it.each([
    ['hybrid', true, 'sfu'],
    ['hybrid', false, 'p2p'],
    ['sfu', true, 'sfu'],
    ['p2p', true, 'p2p'],
    ['p2p', false, 'p2p'],
  ] as const)('%s with LiveKit configured=%s selects %s', (mode, configured, transport) => {
    expect(selectCallTransport(config(mode, configured), web)).toEqual({ ok: true, transport });
  });

  it('refuses sfu mode without LiveKit instead of falling back', () => {
    expect(selectCallTransport(config('sfu', false), web).ok).toBe(false);
  });

  it('refuses when the config is unknown instead of guessing P2P', () => {
    expect(selectCallTransport(null, web).ok).toBe(false);
  });

  it('treats enabled without a URL as not configured', () => {
    const decision = selectCallTransport({ ...config('hybrid', true), wsUrl: null }, web);
    expect(decision).toEqual({ ok: true, transport: 'p2p' });
  });

  it('native media and E2EE take the SFU and refuse P2P', () => {
    expect(selectCallTransport(config('hybrid', true), { native: true, requireE2EE: true })).toEqual({ ok: true, transport: 'sfu' });
    expect(selectCallTransport(config('hybrid', false), { native: true, requireE2EE: false }).ok).toBe(false);
    expect(selectCallTransport(config('p2p', true), { native: false, requireE2EE: true }).ok).toBe(false);
  });
});
