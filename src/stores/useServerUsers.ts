import { defineStore } from 'pinia';
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '@/supabase';
import type { User } from '@/types';
import { UserStatus } from '@/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { updateUserStatus } from '@/services/ProfileService';
import { userDataService } from '@/services/userDataService';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { debug } from '@/utils/debug'
import { useActivitiesStore } from '@/stores/activities';
import { useVoiceModerationStore } from '@/stores/voiceModeration';

/** A DM call room id (dm-{conversation} or federated-dm-{conversation}-{millis}), not a server channel. */
function isDmRoom(channelId: string | null | undefined): boolean {
  return !!channelId && (channelId.startsWith('dm-') || channelId.startsWith('federated-dm-'));
}

// Last voice_channel_participants upsert; a later update of the same row waits for it.
let voiceRowWrite: PromiseLike<unknown> = Promise.resolve();

// Last occupancy change this store applied, by `${channelId}|${userId}`, kept ROSTER_EVENT_TTL_MS.
// A change applied up to ROSTER_EVENT_GRACE_MS before a roster read started wins over the read:
// a joining client broadcasts before its row write lands.
const occupancyEvents = new Map<string, { joined: boolean; at: number }>();
const ROSTER_EVENT_TTL_MS = 60_000;
const ROSTER_EVENT_GRACE_MS = 5_000;
// Server of every channel the roster has listed.
const channelServers = new Map<string, string>();
// A tab shown again re-reads the roster at most this often.
const ROSTER_VISIBLE_RELOAD_MS = 10_000;
let rosterListenersAttached = false;
let lastRosterReload = { serverId: '', at: 0 };

function noteOccupancy(serverId: string, channelId: string, userId: string, joined: boolean): void {
  channelServers.set(channelId, serverId);
  occupancyEvents.set(`${channelId}|${userId}`, { joined, at: Date.now() });
}
  
export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
    userProfiles: {} as Record<string, User>,
    usersInVoiceChannels: {} as Record<string, string[]>,
    voiceChannelCallStartTimes: {} as Record<string, Date>,
    presenceChannel: null as RealtimeChannel | null,
    voiceChannelBroadcast: null as RealtimeChannel | null,
    // Server whose voice-channels topic voiceChannelBroadcast holds.
    voiceBroadcastServerId: null as string | null,
    // That server is not a remote server's copy.
    voiceBroadcastServerLocal: true,
    // voice-channel:{channelId} topics of that server's restricted channels
    // this user can view (get_restricted_voice_channels).
    restrictedVoiceBroadcasts: {} as Record<string, RealtimeChannel>,
    onlineUsers: new Set<string>(),
    offlineBroadcastChannel: null as RealtimeChannel | null,
    currentServerId: null as string | null,
    membershipSubscriptionActive: false,
  }),
  getters: {
    usernameToUserIdMap: () => {
      const map: Record<string, string> = {};
      const allUsers = userDataService.getAllUsers();
      
      for (const userData of allUsers) {
        if (userData && userData.username) {
          map[userData.username.toLowerCase()] = userData.id;
          
          if (!userData.isLocal && userData.domain) {
            map[`${userData.username}@${userData.domain}`.toLowerCase()] = userData.id;
          }
        }
      }
      return map;
    },
    
    isServerMember: (state) => (userId: string): boolean => {
      return userId in state.userProfiles;
    },
    
    getUserProfile: () => (userId: string): User | null => {
      return userDataService.getUserProfile(userId);
    },
    
    getCacheStats: () => {
      const allUsers = userDataService.getAllUsers();
      return {
        totalCached: allUsers.length,
        mainProfiles: allUsers.length,
        pendingFetches: 0,
        hitRate: 1,
      };
    },
  },
  actions: {
    initializeUserDataIntegration() {
      debug.log('UserDataService is now the single source of truth for user data')
      debug.log('UserDataService integration initialized')
    },

    async fetchUserProfile(userId: string, forceRefresh = false): Promise<User | null> {
      try {
        return await userDataService.fetchUserProfile(userId, forceRefresh);
      } catch (error) {
        debug.error(`Error fetching profile for user ${userId}:`, error);
        return null;
      }
    },

    async fetchMultipleUserProfiles(userIds: string[], forceRefresh = false): Promise<Record<string, User>> {
      try {
        return await userDataService.fetchMultipleUserProfiles(userIds, forceRefresh);
      } catch (error) {
        debug.error('Error batch fetching profiles:', error);
        return {};
      }
    },

    async ensureProfilesAvailable(userIds: string[]): Promise<void> {
      try {
        await userDataService.ensureUsersLoaded(userIds);
      } catch (error) {
        debug.error('Error ensuring profiles are available:', error);
      }
    },

    async fetchUserProfiles(userIds: string[]) {
      await userDataService.ensureUsersLoaded(userIds);
      
      this.userProfiles = {};
      userIds.forEach(userId => {
        const userProfile = userDataService.getUserProfile(userId);
        if (userProfile) {
          this.userProfiles[userId] = userProfile;
        }
      });
    },

    async setStatus(userId: string, status: UserStatus) {
      const currentUser = userDataService.getCurrentUser();
      if (currentUser && currentUser.id === userId) {
        await userDataService.updateCurrentUserStatus(status, true);
      } else {
        const numericStatus = status as number;
        const updatedUser = await updateUserStatus(userId, numericStatus);
        if (updatedUser) {
          if (this.userProfiles[userId]) {
            this.userProfiles[userId].status = status;
          }
        }
      }
    },


    async updatePresence(status: 'online' | 'offline') {
      if (this.presenceChannel) {
        if (status === 'online') {
          await this.presenceChannel.track({
            online_at: new Date().toISOString(),
          });
        } else {
          await this.presenceChannel.untrack();
        }
      }
    },

    updateOnlineUsers(presenceState: Record<string, any>) {
      debug.log('Updating online users from presence:', presenceState);
      
      const onlineUserIds = new Set<string>();
      
      Object.values(presenceState).forEach((presences: any) => {
        presences.forEach((presence: any) => {
          if (presence.user_id) {
            onlineUserIds.add(presence.user_id);
          }
        });
      });
      
      debug.log('Online user IDs:', Array.from(onlineUserIds));
      
      const previouslyOnlineUsers = Array.from(this.onlineUsers);
      previouslyOnlineUsers.forEach((userId: string) => {
        if (!onlineUserIds.has(userId)) {
          debug.log('User went offline:', userId);
          this.setUserOnlineStatus(userId, false);
        }
      });
      
      this.onlineUsers.clear();
      onlineUserIds.forEach((userId: string) => {
        this.onlineUsers.add(userId);
        this.setUserOnlineStatus(userId, true);
      });
      
      debug.log('Online users updated:', this.onlineUsers.size, 'online');
    },

    setUserOnlineStatus(userId: string, isOnline: boolean) {
      const userData = userDataService.getUser(userId);
      if (userData) {
        // Only update isOnline; don't override Away/Busy with auto-Online.
        userData.isOnline = isOnline;
        userData.lastSeen = new Date().toISOString();
        
        if (!isOnline && userData.status === UserStatus.Online) {
          userData.status = UserStatus.Offline;
        }
      }
      
      if (this.userProfiles[userId]) {
        const currentStatus = this.userProfiles[userId].status;
        
        if (!isOnline && currentStatus === UserStatus.Online) {
          this.userProfiles[userId].status = UserStatus.Offline;
        }
      }
    },

    async initializeMembershipTracking(serverId: string) {
      try {
        if (this.currentServerId !== serverId) {
          debug.log(`Initializing membership tracking for server: ${serverId}`)

          this.cleanupMembershipTracking()

          this.currentServerId = serverId
          this.membershipSubscriptionActive = true

          debug.log(`Membership tracking initialized for server: ${serverId}`)
        }
      } catch (error) {
        debug.error('Failed to initialize membership tracking:', error)
      }
    },

    cleanupMembershipTracking() {
      if (this.currentServerId && this.membershipSubscriptionActive) {
        debug.log(`Cleaning up membership tracking for server: ${this.currentServerId}`)
        this.membershipSubscriptionActive = false
      }
    },

    cleanup() {
      this.cleanupMembershipTracking()

      if (this.presenceChannel) {
        this.presenceChannel.unsubscribe()
        this.presenceChannel = null
      }
      if (this.voiceChannelBroadcast) {
        this.voiceChannelBroadcast.unsubscribe()
        this.voiceChannelBroadcast = null
      }
      this.voiceBroadcastServerId = null
      this.voiceBroadcastServerLocal = true
      this.closeRestrictedVoiceBroadcasts()
      if (this.offlineBroadcastChannel) {
        this.offlineBroadcastChannel.unsubscribe()
        this.offlineBroadcastChannel = null
      }

      // BUGS.md Pattern B: also drop cached user state. Leaving profiles /
      // voice membership / presence populated leaked the previous account's
      // data into the next session on a shared device.
      this.userProfiles = {}
      this.usersInVoiceChannels = {}
      this.voiceChannelCallStartTimes = {}
      occupancyEvents.clear()
      channelServers.clear()
      this.onlineUsers.clear()

      this.currentServerId = null
    },

    closeRestrictedVoiceBroadcasts() {
      for (const channel of Object.values(this.restrictedVoiceBroadcasts)) {
        void supabase.removeChannel(channel)
      }
      this.restrictedVoiceBroadcasts = {}
    },

    /**
     * Voice occupancy of a server. Open channels share the private
     * voice-channels:{serverId} topic (accepted members); a channel some member
     * cannot view has its own voice-channel:{channelId} topic, opened here only
     * for the restricted channels this user can view.
     *
     * The roster is read from voice_channel_participants here, on every (re)join of the
     * topic, when the tab is shown again and when the network returns: a user-left sent
     * while this client was elsewhere or offline is never replayed. `local: false` names a
     * remote server's copy (reloadVoiceRoster).
     */
    async setupVoiceChannelBroadcast(serverId: string, opts: { local?: boolean } = {}) {
      if (this.voiceChannelBroadcast) {
        await this.voiceChannelBroadcast.unsubscribe();
      }
      this.closeRestrictedVoiceBroadcasts()
      this.attachRosterListeners()

      debug.log('Setting up voice channel broadcast for server:', serverId);
      void useVoiceModerationStore().load(serverId);

      this.voiceChannelBroadcast = supabase.channel(`voice-channels:${serverId}`, {
        config: {
          private: true,
          broadcast: { self: true },
        },
      });
      this.voiceBroadcastServerId = serverId;
      this.voiceBroadcastServerLocal = opts.local !== false;
      this.voiceChannelBroadcast.on('broadcast', { event: 'voice-channel-event' },
        (payload) => this.handleVoiceChannelEvent(serverId, payload.payload));
      await this.voiceChannelBroadcast.subscribe((status) => {
        // realtime-js reports SUBSCRIBED again after each of its own rejoins.
        if (status === 'SUBSCRIBED' && this.voiceBroadcastServerId === serverId) void this.reloadVoiceRoster(serverId);
      });

      const [{ data: restricted, error }] = await Promise.all([
        supabase.rpc('get_restricted_voice_channels', { p_server_id: serverId }),
        this.reloadVoiceRoster(serverId),
      ]);
      if (error) {
        debug.warn('get_restricted_voice_channels failed:', error.message);
      }
      if (this.voiceBroadcastServerId !== serverId) return;
      for (const channelId of (restricted ?? []) as string[]) {
        const channel = supabase.channel(`voice-channel:${channelId}`, {
          config: { private: true, broadcast: { self: true } },
        });
        channel.on('broadcast', { event: 'voice-channel-event' },
          (payload) => this.handleVoiceChannelEvent(serverId, payload.payload));
        channel.subscribe();
        this.restrictedVoiceBroadcasts[channelId] = channel;
      }
      debug.log('Voice channel broadcast subscribed for server:', serverId);
      
      this.broadcastVoiceChannelEvent(serverId, '', 'request-state', '');
      debug.log('Requested current voice channel state from active users');
    },

    handleVoiceChannelEvent(serverId: string, data: any) {
      debug.log('Received voice channel event:', data);
      const { event, userId, channelId, callStartTime, federated } = data ?? {};

      if (event === 'activity') {
        useActivitiesStore().receiveBroadcast(data);
        return;
      }

      if (event === 'voice-moderation') {
        if (userId && data?.serverId === serverId) {
          useVoiceModerationStore().apply(serverId, userId, { muted: data.muted === true, deafened: data.deafened === true });
        }
        return;
      }

      if (event === 'voice-grants') {
        if (data?.serverId === serverId) {
          void useVoiceModerationStore().recheckGrants(serverId, channelId ?? null, userId ?? null);
        }
        return;
      }

      if (event === 'user-joined') {
        if (channelId && userId) noteOccupancy(serverId, channelId, userId, true);
        if (!this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = [];
        }
        if (!this.usersInVoiceChannels[channelId].includes(userId)) {
          this.usersInVoiceChannels[channelId].push(userId);
        }

        if (callStartTime && !this.voiceChannelCallStartTimes[channelId]) {
          this.voiceChannelCallStartTimes[channelId] = new Date(callStartTime);
          debug.log(`Set call start time for channel ${channelId}:`, this.voiceChannelCallStartTimes[channelId]);
        }

        if (federated && userId) {
          debug.log(`Loading profile for federated voice user: ${userId}`);
          userDataService.ensureUsersLoaded([userId]).catch((err) => {
            debug.warn('Failed to load federated user profile:', err);
          });
        }

        debug.log(`User ${userId} joined voice channel ${channelId}. Total: ${this.usersInVoiceChannels[channelId].length}`);
      } else if (event === 'user-left') {
        // The database announces every deleted row: 'reconciled' for a row LiveKit or the P2P
        // sweep does not vouch for, 'left' for a plain delete (another page or device of this
        // user, or a delete that landed after a quick rejoin). This client is still in that
        // call, so the row returns. A moderation reason stands.
        const voiceStore = useUnifiedVoiceChannelStore();
        if ((data?.reason === 'reconciled' || data?.reason === 'left') && userId && userId === voiceStore.localState.userId
            && voiceStore.isConnected && voiceStore.currentChannelId === channelId
            && voiceStore.currentServerId === serverId && !voiceStore.isFederatedChannel) {
          debug.log(`Voice row for ${channelId} removed while connected; rejoining`);
          void this.restoreVoiceRow(serverId, channelId, userId);
          return;
        }
        if (channelId && userId) noteOccupancy(serverId, channelId, userId, false);
        if (this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
          debug.log(`User ${userId} left voice channel ${channelId}. Total: ${this.usersInVoiceChannels[channelId].length}`);

          if (this.usersInVoiceChannels[channelId].length === 0) {
            delete this.voiceChannelCallStartTimes[channelId];
            debug.log(`Cleared call start time for channel ${channelId} (empty)`);
          }
        }
      } else if (event === 'call-start-time-sync') {
        if (callStartTime) {
          this.voiceChannelCallStartTimes[channelId] = new Date(callStartTime);
          debug.log(`Synced call start time for channel ${channelId}:`, this.voiceChannelCallStartTimes[channelId]);
        }
      } else if (event === 'request-state') {
        const voiceStore = useUnifiedVoiceChannelStore();
        if (voiceStore.isConnected && voiceStore.currentChannelId
            && voiceStore.currentServerId === serverId && !isDmRoom(voiceStore.currentChannelId)) {
          debug.log('Responding to state request with our voice channel presence');
          this.broadcastVoiceChannelEvent(
            serverId,
            voiceStore.currentChannelId,
            'user-joined',
            voiceStore.localState.userId,
            voiceStore.callStartTime?.toISOString()
          );
        }
      }
    },

    /**
     * Replaces the roster of a server's channels with its voice_channel_participants rows.
     * Recent occupancy changes (ROSTER_EVENT_GRACE_MS) win over the read; this client's own
     * call is kept. A remote server's copy holds rows for its host's people only
     * (VoiceActivityHandler.recordRemotePresence); this instance's callers there write no row,
     * are known from their broadcasts and request-state answers, and stay listed.
     */
    async reloadVoiceRoster(serverId: string): Promise<void> {
      if (serverId === 'dm' || serverId !== this.voiceBroadcastServerId) return;
      const startedAt = Date.now();
      lastRosterReload = { serverId, at: startedAt };
      let data: Array<{ channel_id: string; user_id: string }> | null = null;
      try {
        const result = await supabase
          .from('voice_channel_participants')
          .select('channel_id, user_id')
          .eq('server_id', serverId);
        if (result.error) throw result.error;
        data = result.data;
      } catch (error) {
        debug.warn('Voice roster read failed:', error instanceof Error ? error.message : error);
        return;
      }
      if (!data) return;

      const rosters: Record<string, string[]> = {};
      const add = (channelId: string, userId: string) => {
        const users = (rosters[channelId] ??= []);
        if (!users.includes(userId)) users.push(userId);
      };
      for (const row of data) {
        channelServers.set(row.channel_id, serverId);
        add(row.channel_id, row.user_id);
      }
      for (const [key, change] of occupancyEvents) {
        if (change.at < Date.now() - ROSTER_EVENT_TTL_MS) {
          occupancyEvents.delete(key);
          continue;
        }
        if (change.at < startedAt - ROSTER_EVENT_GRACE_MS) continue;
        const [channelId, userId] = key.split('|');
        if (channelServers.get(channelId) !== serverId) continue;
        if (change.joined) add(channelId, userId);
        else if (rosters[channelId]) rosters[channelId] = rosters[channelId].filter((id) => id !== userId);
      }
      const voiceStore = useUnifiedVoiceChannelStore();
      const ownChannel = voiceStore.isConnected && voiceStore.currentServerId === serverId
        ? voiceStore.currentChannelId
        : voiceStore.optimisticServerId === serverId ? voiceStore.optimisticChannelId : null;
      if (ownChannel && voiceStore.localState.userId) {
        channelServers.set(ownChannel, serverId);
        add(ownChannel, voiceStore.localState.userId);
      }

      if (!this.voiceBroadcastServerLocal) {
        const unread = new Set<string>();
        for (const [channelId, owner] of channelServers) {
          if (owner !== serverId) continue;
          for (const userId of this.usersInVoiceChannels[channelId] ?? []) {
            if (!rosters[channelId]?.includes(userId)) unread.add(userId);
          }
        }
        if (unread.size > 0) {
          // One read for every listed caller without a row.
          const { data: locals, error } = await supabase
            .from('profiles')
            .select('id')
            .in('id', [...unread])
            .eq('is_local', true);
          if (error) {
            debug.warn('Voice roster locality read failed:', error.message);
            return;
          }
          if (serverId !== this.voiceBroadcastServerId) return;
          const local = new Set((locals ?? []).map((row: { id: string }) => row.id));
          for (const [channelId, owner] of channelServers) {
            if (owner !== serverId) continue;
            for (const userId of this.usersInVoiceChannels[channelId] ?? []) {
              if (local.has(userId)) add(channelId, userId);
            }
          }
        }
      }

      for (const [channelId, owner] of channelServers) {
        if (owner !== serverId) continue;
        const users = rosters[channelId] ?? [];
        if (users.length > 0) {
          this.usersInVoiceChannels[channelId] = users;
        } else if (this.usersInVoiceChannels[channelId]) {
          delete this.usersInVoiceChannels[channelId];
          delete this.voiceChannelCallStartTimes[channelId];
        }
      }
    },

    /** Re-reads the viewed server's roster when the tab is shown again or the network returns. */
    attachRosterListeners() {
      if (rosterListenersAttached || typeof window === 'undefined') return;
      rosterListenersAttached = true;
      document.addEventListener('visibilitychange', () => {
        const store = useServerUsersStore();
        const serverId = store.voiceBroadcastServerId;
        if (document.visibilityState !== 'visible' || !serverId) return;
        if (lastRosterReload.serverId === serverId && Date.now() - lastRosterReload.at < ROSTER_VISIBLE_RELOAD_MS) return;
        void store.reloadVoiceRoster(serverId);
      });
      window.addEventListener('online', () => {
        const store = useServerUsersStore();
        if (store.voiceBroadcastServerId) void store.reloadVoiceRoster(store.voiceBroadcastServerId);
      });
    },

    /**
     * Sends on the voice topic of the server it was opened for, and only for
     * that server's channels: a DM call or another server's channel would
     * reach the members of whichever server was viewed last.
     */
    broadcastVoiceChannelEvent(serverId: string, channelId: string, event: string, userId: string, callStartTime?: string) {
      if (!this.voiceChannelBroadcast) {
        debug.error('Voice channel broadcast not initialized');
        return;
      }
      if (serverId !== this.voiceBroadcastServerId || isDmRoom(channelId)) {
        return;
      }

      // A restricted channel's occupancy stays on its own topic; a request for
      // state goes to every topic of the server.
      const message = {
        type: 'broadcast' as const,
        event: 'voice-channel-event',
        payload: { event, userId, channelId, callStartTime }
      };
      const restricted = channelId ? this.restrictedVoiceBroadcasts[channelId] : undefined;
      if (restricted) {
        restricted.send(message);
      } else {
        this.voiceChannelBroadcast.send(message);
      }
      if (!channelId) {
        for (const channel of Object.values(this.restrictedVoiceBroadcasts)) channel.send(message);
      }
      
      debug.log(`Broadcasted ${event} for user ${userId} in channel ${channelId}`, callStartTime ? `with start time ${callStartTime}` : '');
    },

    getUsersInVoiceChannel(channelId: string): string[] {
      return this.usersInVoiceChannels[channelId] || [];
    },

    getCallStartTime(channelId: string): Date | null {
      return this.voiceChannelCallStartTimes[channelId] || null;
    },

    async joinVoiceChannel(serverId: string, channelId: string, userId: string, isLocalServer: boolean = true) {
      try {
        const isFirstUser = !this.usersInVoiceChannels[channelId] || this.usersInVoiceChannels[channelId].length === 0;
        if (!isDmRoom(channelId) && serverId !== 'dm') noteOccupancy(serverId, channelId, userId, true);
        
        if (!this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = [];
        }
        if (!this.usersInVoiceChannels[channelId].includes(userId)) {
          this.usersInVoiceChannels[channelId].push(userId);
        }

        let callStartTime: string | undefined;
        if (isFirstUser) {
          this.voiceChannelCallStartTimes[channelId] = new Date();
          callStartTime = this.voiceChannelCallStartTimes[channelId].toISOString();
          debug.log(`First user - setting call start time for channel ${channelId}`);
        } else {
          callStartTime = this.voiceChannelCallStartTimes[channelId]?.toISOString();
        }

        // DM/federated calls use non-UUID IDs; only local server channels write to voice_channel_participants.
        const isDMCall = serverId === 'dm' || channelId.startsWith('dm-') || channelId.startsWith('federated-dm-');
        if (isLocalServer && !isDMCall) {
          voiceRowWrite = supabase
            .from('voice_channel_participants')
            .upsert({
              channel_id: channelId,
              server_id: serverId,
              user_id: userId,
              joined_at: new Date().toISOString(),
              is_federated: false,
              metadata: {},
            }, { onConflict: 'channel_id,user_id' })
            .then(({ error }) => {
              if (error) {
                debug.warn('Failed to write to voice_channel_participants:', error.message);
              } else {
                debug.log('Wrote to voice_channel_participants');
              }
            });
        } else if (isDMCall) {
          debug.log('DM voice call - skipping voice_channel_participants DB write');
        } else {
          debug.log('Federated voice channel - skipping local DB write');
        }

        this.broadcastVoiceChannelEvent(serverId, channelId, 'user-joined', userId, callStartTime);
        
        debug.log(`User ${userId} joined voice channel ${channelId}`);
        return true;
      } catch (error) {
        debug.error('Error joining voice channel:', error);
        return false;
      }
    },

    async leaveVoiceChannel(serverId: string, channelId: string, userId: string, isLocalServer: boolean = true) {
      try {
        if (!isDmRoom(channelId) && serverId !== 'dm') noteOccupancy(serverId, channelId, userId, false);
        if (this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
          
          if (this.usersInVoiceChannels[channelId].length === 0) {
            delete this.voiceChannelCallStartTimes[channelId];
            debug.log(`Cleared call start time for channel ${channelId}`);
          }
        }

        const isDMCall = serverId === 'dm' || channelId.startsWith('dm-') || channelId.startsWith('federated-dm-');
        if (isLocalServer && !isDMCall) {
          supabase
            .from('voice_channel_participants')
            .delete()
            .eq('channel_id', channelId)
            .eq('user_id', userId)
            .then(({ error }) => {
              if (error) {
                debug.warn('Failed to delete from voice_channel_participants:', error.message);
              } else {
                debug.log('Removed from voice_channel_participants');
              }
            });
        } else if (isDMCall) {
          debug.log('DM voice call - skipping voice_channel_participants DB delete');
        } else {
          debug.log('Federated voice channel - skipping local DB delete');
        }

        this.broadcastVoiceChannelEvent(serverId, channelId, 'user-left', userId);
        
        debug.log(`User ${userId} left voice channel ${channelId}`);
        return true;
      } catch (error) {
        debug.error('Error leaving voice channel:', error);
        return false;
      }
    },

    /**
     * Records the transport of this client's row. A 'p2p' row is left alone by the
     * server's LiveKit reconciliation.
     */
    async markVoiceTransport(channelId: string, userId: string, transport: 'p2p' | 'livekit') {
      if (isDmRoom(channelId)) return;
      await voiceRowWrite;
      const { error } = await supabase
        .from('voice_channel_participants')
        .update({ metadata: { transport } })
        .eq('channel_id', channelId)
        .eq('user_id', userId);
      if (error) debug.warn('Failed to record voice transport:', error.message);
    },

    /**
     * Stamps this client's row as live (P2P: no LiveKit room vouches for it). A row the
     * server removed is written back.
     */
    async touchVoiceParticipant(serverId: string, channelId: string, userId: string) {
      if (isDmRoom(channelId) || serverId === 'dm') return;
      await voiceRowWrite;
      const { data, error } = await supabase.rpc('touch_voice_participant', { p_channel_id: channelId });
      if (error) {
        debug.warn('touch_voice_participant failed:', error.message);
        return;
      }
      if (data === false) await this.restoreVoiceRow(serverId, channelId, userId);
    },

    /** Writes this client's row again, with its transport, while it is in the call. */
    async restoreVoiceRow(serverId: string, channelId: string, userId: string) {
      await this.joinVoiceChannel(serverId, channelId, userId, true);
      if (useUnifiedVoiceChannelStore().connectionMode !== 'p2p') return;
      await this.markVoiceTransport(channelId, userId, 'p2p');
      const { error } = await supabase.rpc('touch_voice_participant', { p_channel_id: channelId });
      if (error) debug.warn('touch_voice_participant failed:', error.message);
    },

    /**
     * Leave from an unloading page: the row delete outlives the page (fetch keepalive),
     * and user-left goes out on the open voice topic.
     */
    leaveVoiceChannelOnUnload(serverId: string, channelId: string, userId: string, accessToken: string | undefined) {
      if (isDmRoom(channelId) || !accessToken) return;
      try {
        const query = `channel_id=eq.${encodeURIComponent(channelId)}&user_id=eq.${encodeURIComponent(userId)}`;
        void fetch(`${SUPABASE_URL}/rest/v1/voice_channel_participants?${query}`, {
          method: 'DELETE',
          keepalive: true,
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
        }).catch(() => {});
      } catch {
        // The server's LiveKit reconciliation removes the row.
      }
      this.broadcastVoiceChannelEvent(serverId, channelId, 'user-left', userId);
    },

    isUserInVoiceChannel(userId: string, channelId: string): boolean {
      return this.usersInVoiceChannels[channelId]?.includes(userId) || false;
    },

    async leaveAllVoiceChannels(serverId: string, userId: string) {
      const channelsToLeave = Object.keys(this.usersInVoiceChannels).filter(channelId => 
        this.usersInVoiceChannels[channelId].includes(userId)
      );

      for (const channelId of channelsToLeave) {
        await this.leaveVoiceChannel(serverId, channelId, userId);
      }
    },

    /**
     * Clean up a disconnected user from voice channel state (crash/network loss).
     */
    cleanupDisconnectedUser(serverId: string, channelId: string, userId: string) {
      debug.log(`Cleaning up disconnected user ${userId} from channel ${channelId}`);
      if (!isDmRoom(channelId) && serverId !== 'dm') noteOccupancy(serverId, channelId, userId, false);
      
      if (this.usersInVoiceChannels[channelId]) {
        this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
        
        if (this.usersInVoiceChannels[channelId].length === 0) {
          delete this.voiceChannelCallStartTimes[channelId];
        }
      }

      const isDMCall = channelId.startsWith('dm-') || channelId.startsWith('federated-dm-');
      if (!isDMCall) {
        supabase
          .from('voice_channel_participants')
          .delete()
          .eq('channel_id', channelId)
          .eq('user_id', userId)
          .then(({ error }) => {
            if (error) {
              debug.warn('Failed to cleanup voice_channel_participants:', error.message);
            } else {
              debug.log('Cleaned up disconnected user from voice_channel_participants');
            }
          });
      }

      this.broadcastVoiceChannelEvent(serverId, channelId, 'user-left', userId);
    },
  }
});