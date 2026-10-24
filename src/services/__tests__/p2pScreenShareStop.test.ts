import { describe, expect, it, vi } from 'vitest';
import { UnifiedWebRTCService } from '../unifiedWebRTC';

// Stopping a P2P screen share removes the screen senders from every peer and
// renegotiates. RTCPeerConnection.removeTrack sets sender.track to null, as the
// fake below does.

class FakeTrack {
  stopped = false;
  constructor(public id: string, public kind: 'audio' | 'video') {}
  stop() { this.stopped = true; }
}

function sharingTo(peers: string[]) {
  const svc = new UnifiedWebRTCService();
  const s = svc as any;
  const screenVideo = new FakeTrack('screen-video', 'video');
  const screenAudio = new FakeTrack('screen-audio', 'audio');
  const mic = new FakeTrack('mic', 'audio');
  s.localScreenStream = { getTracks: () => [screenVideo, screenAudio] };
  s.localMediaState.isScreenSharing = true;
  s.screenShareVideoTrackId = screenVideo.id;
  s.screenShareAudioTrackId = screenAudio.id;
  const pcs = peers.map((peer) => {
    const senders: Array<{ track: FakeTrack | null }> = [
      { track: mic },
      { track: screenVideo },
      { track: screenAudio },
    ];
    const pc = {
      senders,
      getSenders: () => senders,
      removeTrack: vi.fn((sender: { track: FakeTrack | null }) => { sender.track = null; }),
    };
    s.connections.set(peer, { peerConnection: pc });
    return pc;
  });
  const renegotiate = vi.spyOn(s, 'renegotiateWithPeer').mockResolvedValue(undefined);
  vi.spyOn(s, 'broadcastMediaState').mockResolvedValue(undefined);
  return { svc, pcs, renegotiate, screenVideo, screenAudio, mic };
}

describe('P2P screen share stop', () => {
  it('removes both screen senders from every peer and renegotiates each once', async () => {
    const { svc, pcs, renegotiate, screenVideo, screenAudio } = sharingTo(['a', 'b']);
    await expect(svc.toggleScreenShare()).resolves.toBe(false);
    for (const pc of pcs) {
      expect(pc.removeTrack).toHaveBeenCalledTimes(2);
      expect(pc.senders.map((x) => x.track?.id ?? null)).toEqual(['mic', null, null]);
    }
    expect(renegotiate.mock.calls.map(([peer]) => peer)).toEqual(['a', 'b']);
    expect(screenVideo.stopped).toBe(true);
    expect(screenAudio.stopped).toBe(true);
    expect((svc as any).localMediaState.isScreenSharing).toBe(false);
  });

  it('leaves the mic sender in place', async () => {
    const { svc, pcs, mic } = sharingTo(['a']);
    await svc.toggleScreenShare();
    expect(pcs[0].removeTrack).not.toHaveBeenCalledWith(expect.objectContaining({ track: mic }));
    expect(mic.stopped).toBe(false);
  });
});
