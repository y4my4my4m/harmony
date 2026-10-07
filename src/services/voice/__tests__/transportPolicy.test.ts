import { describe, expect, it } from 'vitest';
import { selectCallTransport } from '../transportPolicy';
import type { LiveKitConfig } from '../../livekitTokens';

const config = (mode: LiveKitConfig['mode'], configured: boolean): LiveKitConfig => ({
  enabled: configured,
  mode,
  wsUrl: configured ? 'wss://livekit.example.test' : null,
  allowFederatedVoice: false,
});

const noE2EE = { requireE2EE: false };

describe('selectCallTransport', () => {
  it.each([
    ['hybrid', true, 'sfu'],
    ['hybrid', false, 'p2p'],
    ['sfu', true, 'sfu'],
    ['p2p', true, 'p2p'],
    ['p2p', false, 'p2p'],
  ] as const)('%s with LiveKit configured=%s selects %s', (mode, configured, transport) => {
    expect(selectCallTransport(config(mode, configured), noE2EE)).toEqual({ ok: true, transport });
  });

  it('refuses sfu mode without LiveKit instead of falling back', () => {
    expect(selectCallTransport(config('sfu', false), noE2EE).ok).toBe(false);
  });

  it('refuses when the config is unknown instead of guessing P2P', () => {
    expect(selectCallTransport(null, noE2EE).ok).toBe(false);
  });

  it('treats enabled without a URL as not configured', () => {
    const decision = selectCallTransport({ ...config('hybrid', true), wsUrl: null }, noE2EE);
    expect(decision).toEqual({ ok: true, transport: 'p2p' });
  });

  it('E2EE takes the SFU and refuses P2P', () => {
    expect(selectCallTransport(config('hybrid', true), { requireE2EE: true })).toEqual({ ok: true, transport: 'sfu' });
    expect(selectCallTransport(config('hybrid', false), { requireE2EE: true }).ok).toBe(false);
    expect(selectCallTransport(config('p2p', true), { requireE2EE: true }).ok).toBe(false);
  });
});
