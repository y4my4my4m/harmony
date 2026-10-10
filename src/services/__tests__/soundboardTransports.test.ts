import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => ({
  setLogLevel: () => {},
  LogLevel: { debug: 0, warn: 1 },
  Track: { Source: { Microphone: 'microphone' } },
  ConnectionState: { Connected: 'connected' },
}));

import { LiveKitWebRTCService, loadLiveKit } from '../livekitWebRTC';
import { UnifiedWebRTCService } from '../unifiedWebRTC';
import { SOUNDBOARD_TOPIC, buildSoundboardMessage } from '../soundboard/protocol';

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

  it('broadcasts plays on the signalling channel', () => {
    const { svc } = service();
    const send = vi.fn();
    (svc as any).signalChannel = { send };
    svc.sendSoundboard(play);
    expect(send).toHaveBeenCalledWith({ type: 'broadcast', event: 'soundboard', payload: { from: 'me', message: play } });
  });
});
