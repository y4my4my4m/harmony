import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => ({
  setLogLevel: () => {},
  LogLevel: { debug: 0, warn: 1 },
  ConnectionState: { Connected: 'connected' },
}));

import { LiveKitWebRTCService, loadLiveKit } from '../livekitWebRTC';
import { LIVE_REACTION_TOPIC, MAX_LIVE_REACTION_BYTES } from '../voice/liveReactions';

// Live reactions ride lossy LiveKit data on their own topic. Only packets from
// registered room participants surface, under the participant's profile id.

function service(state = 'connected') {
  const svc = new LiveKitWebRTCService();
  const publishData = vi.fn(async () => {});
  (svc as any).room = {
    state,
    localParticipant: { identity: 'me', publishData },
    remoteParticipants: new Map([['bob', { identity: 'bob' }]]),
  };
  (svc as any).currentUserId = 'me';
  const states = (svc as any).allUserStates as Map<string, { userId: string }>;
  states.set('bob', { userId: 'bob' });
  // A federated participant: room identity differs from the local profile id.
  states.set('federated:https://remote.test/users/fed', { userId: 'fed-uuid' });
  return { svc, publishData };
}

const payload = new TextEncoder().encode('{"type":"live_reaction"}');

describe('LiveKit live reactions', () => {
  beforeEach(async () => {
    await loadLiveKit();
  });

  it('publishes lossy on the reaction topic', () => {
    const { svc, publishData } = service();
    expect(svc.sendLiveReaction(payload)).toBe(true);
    expect(publishData).toHaveBeenCalledWith(payload, { reliable: false, topic: LIVE_REACTION_TOPIC });
  });

  it('sends nothing while not connected or when oversized', () => {
    const { svc, publishData } = service('reconnecting');
    expect(svc.sendLiveReaction(payload)).toBe(false);
    const connected = service();
    expect(connected.svc.sendLiveReaction(new Uint8Array(MAX_LIVE_REACTION_BYTES + 1))).toBe(false);
    expect(publishData).not.toHaveBeenCalled();
    expect(connected.publishData).not.toHaveBeenCalled();
  });

  it('surfaces packets from registered participants under their profile id', () => {
    const { svc } = service();
    const heard = vi.fn();
    svc.on('live-reaction', heard);
    (svc as any).handleLiveReactionData(payload, { identity: 'federated:https://remote.test/users/fed' });
    expect(heard).toHaveBeenCalledWith({ userId: 'fed-uuid', payload });
  });

  it('drops packets from unknown or missing senders', () => {
    const { svc } = service();
    const heard = vi.fn();
    svc.on('live-reaction', heard);
    (svc as any).handleLiveReactionData(payload, { identity: 'mallory' });
    (svc as any).handleLiveReactionData(payload, undefined);
    (svc as any).handleLiveReactionData(new Uint8Array(MAX_LIVE_REACTION_BYTES + 1), { identity: 'bob' });
    expect(heard).not.toHaveBeenCalled();
  });

  it('maps between profile ids and room identities', () => {
    const { svc } = service();
    expect(svc.liveReactionWireId('bob')).toBe('bob');
    expect(svc.liveReactionWireId('me')).toBe('me');
    expect(svc.liveReactionWireId('nobody')).toBeNull();
    expect(svc.liveReactionUserId('federated:https://remote.test/users/fed')).toBe('fed-uuid');
    expect(svc.liveReactionUserId('me')).toBe('me');
    expect(svc.liveReactionUserId('nobody')).toBeNull();
  });
});
