import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => ({ relay: true }));
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: (name: string) => name === 'signal-relay' && capabilities.relay }));

vi.mock('livekit-client', () => ({
  setLogLevel: () => {},
  LogLevel: { debug: 0, warn: 1 },
  Track: { Source: { Microphone: 'microphone' } },
  ConnectionState: { Connected: 'connected' },
}));

import { LiveKitWebRTCService, loadLiveKit } from '../livekitWebRTC';
import { UnifiedWebRTCService } from '../unifiedWebRTC';
import { SOUNDBOARD_TOPIC, buildSoundboardMessage } from '../soundboard/protocol';
import { supabase } from '@/supabase';

const SERVER = '55555555-0000-0000-0000-000000000005';
const BOB = '22222222-0000-0000-0000-000000000002';
const play = buildSoundboardMessage('default:ding', SERVER, BOB);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

beforeAll(async () => {
  await loadLiveKit();
});

describe('LiveKit soundboard data', () => {
  function service() {
    const svc = new LiveKitWebRTCService();
    const events: unknown[] = [];
    svc.on('soundboard', (e: unknown) => events.push(e));
    (svc as any).allUserStates.set('federated:https://harmony.test/users/bob', { userId: BOB });
    return { svc, events, receive: (payload: Uint8Array, participant?: unknown) => (svc as any).handleSoundboardData(payload, participant) };
  }

  it('reports a play with the sender resolved to a profile and the token grants', () => {
    const { events, receive } = service();
    receive(encode(play), { identity: 'federated:https://harmony.test/users/bob', metadata: JSON.stringify({ soundboard: false }) });
    receive(encode(play), {
      identity: 'federated:https://harmony.test/users/bob',
      metadata: JSON.stringify({ soundboard: true, soundboardExternal: false }),
    });
    expect(events).toEqual([
      { userId: BOB, message: play, granted: false, externalGranted: null },
      { userId: BOB, message: play, granted: true, externalGranted: false },
    ]);
  });

  it('drops data from an unresolved participant, without a sender, oversized or unparseable', () => {
    const { events, receive } = service();
    receive(encode(play), { identity: 'federated:https://elsewhere.test/users/eve' });
    receive(encode(play));
    receive(encode({ ...play, pad: 'x'.repeat(2000) }), { identity: 'federated:https://harmony.test/users/bob' });
    receive(new TextEncoder().encode('{nope'), { identity: 'federated:https://harmony.test/users/bob' });
    expect(events).toEqual([]);
  });

  it('publishes plays reliably on the soundboard topic', () => {
    const svc = new LiveKitWebRTCService();
    const publishData = vi.fn(async () => undefined);
    (svc as any).room = { state: 'connected', localParticipant: { publishData } };
    svc.sendSoundboard(play);
    expect(publishData).toHaveBeenCalledWith(encode(play), { reliable: true, topic: SOUNDBOARD_TOPIC });
  });
});

describe('P2P soundboard broadcasts', () => {
  beforeEach(() => { capabilities.relay = true; });

  function service() {
    const svc = new UnifiedWebRTCService();
    const events: unknown[] = [];
    svc.on('soundboard', (e: unknown) => events.push(e));
    (svc as any).currentUserId = 'me';
    (svc as any).allUserStates.set(BOB, { userId: BOB });
    return { svc, events, receive: (raw: unknown) => (svc as any).handleSoundboard(raw) };
  }

  it('reports a play from a participant of the room', () => {
    const { events, receive } = service();
    receive({ from: BOB, message: play });
    expect(events).toEqual([{ userId: BOB, message: play, granted: null, externalGranted: null }]);
  });

  it('drops plays from itself, strangers and malformed envelopes', () => {
    const { events, receive } = service();
    receive({ from: 'me', message: play });
    receive({ from: 'eve', message: play });
    receive({ message: play });
    receive(null);
    expect(events).toEqual([]);
  });

  it('broadcasts plays on the signalling channel of an instance without send_signal', () => {
    const { svc } = service();
    const send = vi.fn();
    (svc as any).signalChannel = { send };
    (svc as any).channelId = 'room-1';
    capabilities.relay = false;
    svc.sendSoundboard(play);
    expect(send).toHaveBeenCalledWith({ type: 'broadcast', event: 'soundboard', payload: { from: 'me', message: play } });
  });

  it('relays plays through send_signal, and reports a relayed play under the database\'s sender', async () => {
    const { svc, events } = service();
    const send = vi.fn();
    const rpc = vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as never);
    (svc as any).signalChannel = { send };
    (svc as any).channelId = 'room-1';
    svc.sendSoundboard(play);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('send_signal', {
      p_topic: 'harmony-voice-room-1',
      p_event: 'signals',
      p_payload: { messages: [{ type: 'soundboard', data: play, timestamp: expect.any(Number), session: expect.any(String) }] },
    });

    (svc as any).handleRelayed({ from: BOB, messages: [{ type: 'soundboard', from: 'me', data: play }] });
    expect(events).toEqual([{ userId: BOB, message: play, granted: null, externalGranted: null }]);
  });
});
