import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => {
  const names = [
    'ConnectionStateChanged', 'Disconnected', 'Reconnecting', 'Reconnected', 'SignalReconnecting',
    'ParticipantConnected', 'ParticipantDisconnected', 'TrackPublished', 'TrackUnpublished',
    'TrackSubscribed', 'TrackUnsubscribed', 'TrackSubscriptionFailed', 'TrackMuted', 'TrackUnmuted',
    'ActiveSpeakersChanged', 'DataReceived', 'LocalTrackPublished', 'LocalTrackUnpublished',
    'MediaDevicesError', 'AudioPlaybackStatusChanged', 'ParticipantMetadataChanged',
    'ParticipantAttributesChanged', 'ConnectionQualityChanged', 'RoomMetadataChanged',
    'TrackStreamStateChanged', 'EncryptionError', 'ParticipantEncryptionStatusChanged',
  ];
  const RoomEvent = new Proxy(Object.fromEntries(names.map(n => [n, n])), {
    get: (target, key: string) => target[key] ?? key,
  });
  return {
    setLogLevel: () => {},
    LogLevel: { debug: 0, warn: 1 },
    RoomEvent,
    ParticipantEvent: new Proxy({}, { get: (_t, key: string) => key }),
    Track: {
      Source: { Microphone: 'microphone', Camera: 'camera', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' },
      Kind: { Video: 'video', Audio: 'audio' },
    },
    ConnectionState: { Connected: 'connected' },
    DisconnectReason: {},
    RemoteAudioTrack: class {},
  };
});
vi.mock('@/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
}));

import { LiveKitWebRTCService, loadLiveKit } from '../livekitWebRTC';

type Handler = (...args: any[]) => unknown;

/** A room whose handlers the test fires directly. */
function harness() {
  const svc = new LiveKitWebRTCService();
  const handlers = new Map<string, Handler>();
  const remoteParticipants = new Map<string, unknown>();
  (svc as any).room = {
    on: (event: string, cb: Handler) => { handlers.set(event, cb); return (svc as any).room; },
    remoteParticipants,
    localParticipant: { identity: 'me', trackPublications: new Map(), getTrackPublication: () => undefined, on: () => {} },
    state: 'connected',
  };
  (svc as any).setupRoomListeners();
  const fire = async (event: string, ...args: unknown[]) => { await handlers.get(event)?.(...args); };
  return { svc, fire, remoteParticipants };
}

/** A streaming participant registered under a resolved user id. */
function streamer(svc: LiveKitWebRTCService, identity: string) {
  const publications = new Map<string, any>();
  const participant = {
    identity,
    trackPublications: publications,
    getTrackPublication: (source: string) => [...publications.values()].find(p => p.source === source),
  };
  (svc as any).allUserStates.set(identity, { userId: identity, isScreenSharing: false, hasScreenShareAudio: false });
  const publish = (sid: string, source = 'screen_share') => {
    const pub = { trackSid: sid, source, isDesired: true, setSubscribed: vi.fn(function (this: any, v: boolean) { this.isDesired = v; }) };
    publications.set(sid, pub);
    return pub;
  };
  const unpublish = (sid: string) => {
    const pub = publications.get(sid);
    publications.delete(sid);
    return pub;
  };
  return { participant, publish, unpublish };
}

beforeAll(async () => {
  await loadLiveKit();
});

describe('watched streams across a restart', () => {
  it('a stream that ended while watched is watched again when its user streams within the grace period', async () => {
    const { svc, fire } = harness();
    const s = streamer(svc, 'user-a');
    const first = s.publish('TR_1');
    await fire('TrackPublished', first, s.participant);
    (svc as any).watchedStreams.add('user-a');

    await fire('TrackUnpublished', s.unpublish('TR_1'), s.participant);
    expect((svc as any).watchedStreams.has('user-a')).toBe(false);

    const second = s.publish('TR_2');
    await fire('TrackPublished', second, s.participant);
    expect((svc as any).watchedStreams.has('user-a')).toBe(true);
    expect(second.isDesired).toBe(true);
  });

  it('a stream that was not watched stays unwatched after a restart', async () => {
    const { svc, fire } = harness();
    const s = streamer(svc, 'user-b');
    await fire('TrackPublished', s.publish('TR_1'), s.participant);
    await fire('TrackUnpublished', s.unpublish('TR_1'), s.participant);
    const again = s.publish('TR_2');
    await fire('TrackPublished', again, s.participant);
    expect((svc as any).watchedStreams.has('user-b')).toBe(false);
    expect(again.setSubscribed).toHaveBeenCalledWith(false);
  });
});

describe('media-state messages', () => {
  it('cannot mark a published stream as stopped', async () => {
    const { svc, fire } = harness();
    const s = streamer(svc, 'user-c');
    await fire('TrackPublished', s.publish('TR_1'), s.participant);
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'media-state', data: { isScreenSharing: false, isMuted: true } }));
    await fire('DataReceived', payload, s.participant);
    const state = (svc as any).allUserStates.get('user-c');
    expect(state.isScreenSharing).toBe(true);
    expect(state.isMuted).toBe(true);
  });
});

describe('participant reconnect', () => {
  it('a late disconnect does not remove the reconnected participant', async () => {
    const { svc, fire, remoteParticipants } = harness();
    const s = streamer(svc, 'user-d');
    remoteParticipants.set('user-d', s.participant);
    await fire('ParticipantDisconnected', s.participant);
    expect((svc as any).allUserStates.has('user-d')).toBe(true);
  });
});
