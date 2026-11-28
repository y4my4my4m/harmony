import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => ({ relay: true }));
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: (name: string) => name === 'signal-relay' && capabilities.relay }));

import { supabase } from '@/supabase';
import { DEFAULT_ICE_SERVERS, loadIceServers, toIceServers } from '../iceServers';

const GOOGLE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

describe('toIceServers', () => {
  it('unset STUN is the default list, Google STUN with no TURN', () => {
    expect(DEFAULT_ICE_SERVERS).toEqual(GOOGLE);
    expect(toIceServers({ stun: null, turn: null })).toEqual(GOOGLE);
    expect(toIceServers(null)).toEqual(GOOGLE);
  });

  it('an empty STUN list is no STUN server', () => {
    expect(toIceServers({ stun: [], turn: null })).toEqual([]);
  });

  it('keeps the instance\'s STUN and TURN servers, and drops URLs of another scheme', () => {
    expect(toIceServers({
      stun: ['stun:stun.example.org:3478', 'https://bad.example', 7],
      turn: { urls: ['turns:turn.example.org:5349', 'stun:wrong.example'], username: '1700000000:me', credential: 'c2VjcmV0' },
    })).toEqual([
      { urls: ['stun:stun.example.org:3478'] },
      { urls: ['turns:turn.example.org:5349'], username: '1700000000:me', credential: 'c2VjcmV0' },
    ]);
  });

  it('a TURN server without credentials is left out', () => {
    expect(toIceServers({ stun: null, turn: { urls: ['turn:turn.example.org'] } })).toEqual(GOOGLE);
  });
});

describe('loadIceServers', () => {
  beforeEach(() => {
    capabilities.relay = true;
    vi.mocked(supabase.rpc).mockReset();
  });

  it('reads voice_ice_servers', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { stun: [], turn: null }, error: null } as never);
    await expect(loadIceServers()).resolves.toEqual([]);
    expect(supabase.rpc).toHaveBeenCalledWith('voice_ice_servers');
  });

  it('a failed read is the default list', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { message: 'boom' } } as never);
    await expect(loadIceServers()).resolves.toEqual(GOOGLE);
  });

  it('an instance without voice_ice_servers is not asked', async () => {
    capabilities.relay = false;
    await expect(loadIceServers()).resolves.toEqual(GOOGLE);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
