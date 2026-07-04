import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendToInbox = vi.fn().mockResolvedValue(undefined);
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { sendToInbox: (...args: any[]) => sendToInbox(...args) },
}));

const profilesById: Record<string, any> = {};
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from(table: string) {
      const builder: any = {
        _id: null as string | null,
        select() { return builder; },
        update() { return builder; },
        eq(_col: string, val: string) { builder._id = val; return builder; },
        single() {
          return Promise.resolve({ data: table === 'profiles' ? (profilesById[builder._id!] ?? null) : null, error: null });
        },
        then(resolve: any) { return resolve({ data: null, error: null }); },
      };
      return builder;
    },
  }),
}));

import { handleFollowJob } from '../queue/handlers/followHandler.js';

const REMOTE_FOLLOWER = {
  id: 'follower-id',
  username: 'alice',
  is_local: false,
  federated_id: 'https://remote.test/users/alice',
  inbox_url: 'https://remote.test/users/alice/inbox',
};
const LOCAL_TARGET = {
  id: 'target-id',
  username: 'bob',
  is_local: true,
};

describe('handleFollowJob respond', () => {
  beforeEach(() => {
    sendToInbox.mockClear();
    profilesById['follower-id'] = { ...REMOTE_FOLLOWER };
    profilesById['target-id'] = { ...LOCAL_TARGET };
  });

  it('delivers an Accept to the remote follower on approval', async () => {
    await handleFollowJob({
      type: 'respond',
      follow_id: 'follow-1',
      follower_id: 'follower-id',
      following_id: 'target-id',
      status: 'accepted',
      ap_id: 'https://remote.test/activities/follow/1',
    });

    expect(sendToInbox).toHaveBeenCalledTimes(1);
    const [inbox, activity, senderId] = sendToInbox.mock.calls[0];
    expect(inbox).toBe(REMOTE_FOLLOWER.inbox_url);
    expect(senderId).toBe('target-id');
    expect(activity.type).toBe('Accept');
    expect(activity.object.id).toBe('https://remote.test/activities/follow/1');
    expect(activity.object.actor).toBe(REMOTE_FOLLOWER.federated_id);
  });

  it('delivers a Reject on rejection', async () => {
    await handleFollowJob({
      type: 'respond',
      follow_id: 'follow-1',
      follower_id: 'follower-id',
      following_id: 'target-id',
      status: 'rejected',
      ap_id: 'https://remote.test/activities/follow/1',
    });

    expect(sendToInbox).toHaveBeenCalledTimes(1);
    expect(sendToInbox.mock.calls[0][1].type).toBe('Reject');
  });

  it('skips when the follower is local', async () => {
    profilesById['follower-id'].is_local = true;
    await handleFollowJob({
      type: 'respond',
      follow_id: 'follow-1',
      follower_id: 'follower-id',
      following_id: 'target-id',
      status: 'accepted',
      ap_id: 'x',
    });
    expect(sendToInbox).not.toHaveBeenCalled();
  });

  it('skips when the target is remote', async () => {
    profilesById['target-id'].is_local = false;
    await handleFollowJob({
      type: 'respond',
      follow_id: 'follow-1',
      follower_id: 'follower-id',
      following_id: 'target-id',
      status: 'accepted',
      ap_id: 'x',
    });
    expect(sendToInbox).not.toHaveBeenCalled();
  });

  it('skips on unexpected status', async () => {
    await handleFollowJob({
      type: 'respond',
      follow_id: 'follow-1',
      follower_id: 'follower-id',
      following_id: 'target-id',
      status: 'pending',
      ap_id: 'x',
    });
    expect(sendToInbox).not.toHaveBeenCalled();
  });

  it('skips when follower has no inbox_url', async () => {
    profilesById['follower-id'].inbox_url = null;
    await handleFollowJob({
      type: 'respond',
      follow_id: 'follow-1',
      follower_id: 'follower-id',
      following_id: 'target-id',
      status: 'accepted',
      ap_id: 'x',
    });
    expect(sendToInbox).not.toHaveBeenCalled();
  });
});
