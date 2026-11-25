import { describe, expect, it, vi } from 'vitest';

// The room ends with the page (pagehide, freeze), not on beforeunload: a same-tab link to a file
// the server sends as an attachment fires beforeunload before it turns into a download.

vi.mock('livekit-client', () => ({ setLogLevel: () => {}, LogLevel: { debug: 0, warn: 1 } }));
vi.mock('../voice/remoteAudioMixer', () => ({
  remoteAudioMixer: { setOutputDevice: vi.fn(async () => undefined), reset: vi.fn() },
}));

import { LiveKitWebRTCService } from '../livekitWebRTC';

function inRoom() {
  const svc = new LiveKitWebRTCService();
  const events: string[] = [];
  for (const event of ['channel-left', 'connection-lost']) svc.on(event, () => events.push(event));
  const disconnect = vi.fn(async () => undefined);
  (svc as any).room = { disconnect };
  (svc as any).channelId = 'room-1';
  return { svc, events, disconnect };
}

const pagehide = (persisted: boolean) => {
  const event = new Event('pagehide');
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
};

describe('a LiveKit leave', () => {
  it('stops the captures before the server has the leave', () => {
    const { svc } = inRoom();
    const mic = { stop: vi.fn() };
    const camera = { stop: vi.fn() };
    (svc as any).room = {
      disconnect: vi.fn(() => new Promise(() => {})),
      localParticipant: { trackPublications: new Map([['a', { track: mic }], ['b', { track: camera }], ['c', {}]]) },
    };
    void svc.leaveChannel();
    expect(mic.stop).toHaveBeenCalledTimes(1);
    expect(camera.stop).toHaveBeenCalledTimes(1);
  });
});

describe('LiveKit room and the page', () => {
  it('Room does not leave with the page itself', () => {
    const svc = new LiveKitWebRTCService();
    expect((svc as any).prepareRoomOptions()).toMatchObject({ disconnectOnPageLeave: false });
  });

  it('a beforeunload keeps the room', async () => {
    const { disconnect, events } = inRoom();
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('a pagehide leaves the room, without a lost connection', async () => {
    const { disconnect, events } = inRoom();
    pagehide(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(events).toContain('channel-left'));
    expect(events).not.toContain('connection-lost');
  });

  it('a page that can be restored reports the lost call', async () => {
    const { disconnect, events } = inRoom();
    pagehide(true);
    expect(disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(events).toContain('connection-lost'));
  });

  it('a frozen page leaves the room', async () => {
    const { disconnect, events } = inRoom();
    document.dispatchEvent(new Event('freeze'));
    expect(disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(events).toContain('connection-lost'));
  });
});
