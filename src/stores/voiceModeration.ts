import { defineStore } from 'pinia';
import type { VoiceModerationFlags } from '@/services/voice/voiceModerationApi';
import { debug } from '@/utils/debug';

/**
 * Server mute, server deafen, move and disconnect (20261017100002_voice_moderation.sql).
 *
 * Flags of a server's members come from get_server_voice_moderation and the
 * voice-moderation broadcast; flags of the call's participants also from their
 * LiveKit metadata, which a remote server's host sets. A remote server's copy
 * holds what its Group sent (20261017100005_voice_moderation_followups.sql).
 * The member's own client follows a move or disconnect from user:<self>
 * (voice:moved), the host's own or relayed by this instance for a remote
 * server, and, while realtime is down, from my_voice_state every
 * SELF_POLL_OFFLINE_MS. A voice-grants broadcast makes a P2P client re-read
 * its grants.
 */

/** my_voice_state re-read period in a call, ms. */
const SELF_POLL_MS = 15_000;
/** Re-read period while realtime is down, ms. */
const SELF_POLL_OFFLINE_MS = 3_000;

export interface VoiceModerationTarget {
  id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
}

export interface VoiceModerationCapabilities {
  mute: boolean;
  deafen: boolean;
  move: boolean;
  kick: boolean;
  ban: boolean;
}

export const NO_VOICE_CAPABILITIES: VoiceModerationCapabilities = {
  mute: false, deafen: false, move: false, kick: false, ban: false,
};

export type VoiceDepartureReason = 'moved' | 'disconnected' | 'removed' | 'timed_out' | 'revoked';

const DEPARTURE_TEXT: Record<Exclude<VoiceDepartureReason, 'moved'>, string> = {
  disconnected: 'youWereDisconnected',
  removed: 'youWereRemoved',
  timed_out: 'youWereTimedOut',
  revoked: 'youLostAccess',
};

const NOT_FLAGGED: VoiceModerationFlags = { muted: false, deafened: false };

// Loaded on first use: the voice store reads this store's state, and its
// tests stub what it imports.
const api = () => import('@/services/voice/voiceModerationApi');
const stores = async () => {
  const [{ useNotificationStore }, { useServerChannelStore }, { useServerUsersStore }, { useUnifiedVoiceChannelStore }] =
    await Promise.all([
      import('@/stores/useNotification'),
      import('@/stores/useServerChannel'),
      import('@/stores/useServerUsers'),
      import('@/stores/unifiedVoiceChannel'),
    ]);
  return {
    notify: useNotificationStore(),
    serverChannels: useServerChannelStore(),
    serverUsers: useServerUsersStore(),
    voice: useUnifiedVoiceChannelStore(),
  };
};

async function say(text: string, assertive = false): Promise<void> {
  const { announce } = await import('@/composables/useAnnouncer');
  announce(text, assertive ? { politeness: 'assertive' } : {});
}

async function translate(key: string, params?: Record<string, unknown>): Promise<string> {
  const { i18n } = await import('@/i18n');
  return params ? i18n.global.t(key, params) : i18n.global.t(key);
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

async function realtimeOnline(): Promise<boolean> {
  try {
    const { supabase } = await import('@/supabase');
    return supabase.realtime.isConnected();
  } catch {
    return false;
  }
}

interface ServerRecord { id: string; owner: string; is_local_server?: boolean }

async function powersOf(serverId: string, channelId: string | null | undefined): Promise<{ me: string; server: ServerRecord; all: boolean; inChannel: Record<string, boolean>; serverWide: Record<string, boolean> } | null> {
  const { serverChannels } = await stores();
  const server = (serverChannels.servers.find((s) => s.id === serverId)
    ?? (serverChannels.currentServer?.id === serverId ? serverChannels.currentServer : null)) as ServerRecord | null;
  if (!server || server.is_local_server === false) return null;
  const [{ authContextService }, { roleService }] = await Promise.all([
    import('@/services/AuthContextService'),
    import('@/services/RoleService'),
  ]);
  const me = await authContextService.getCurrentProfileId();
  if (!me) return null;
  const [inChannel, serverWide] = await Promise.all([
    roleService.getUserPermissions(me, serverId, channelId ?? undefined),
    roleService.getUserPermissions(me, serverId),
  ]);
  return {
    me,
    server,
    all: me === server.owner || serverWide.ADMINISTRATOR === true,
    inChannel: inChannel as Record<string, boolean>,
    serverWide: serverWide as Record<string, boolean>,
  };
}

function capabilitiesFrom(p: { all: boolean; inChannel: Record<string, boolean>; serverWide: Record<string, boolean> }): VoiceModerationCapabilities {
  return {
    mute: p.all || p.inChannel.MUTE_MEMBERS === true,
    deafen: p.all || p.inChannel.DEAFEN_MEMBERS === true,
    move: p.all || p.inChannel.MOVE_MEMBERS === true,
    kick: p.all || p.serverWide.KICK_MEMBERS === true,
    ban: p.all || p.serverWide.BAN_MEMBERS === true,
  };
}

export const useVoiceModerationStore = defineStore('voiceModeration', {
  state: () => ({
    /** get_server_voice_moderation and broadcasts, by server then member. */
    byServer: {} as Record<string, Record<string, VoiceModerationFlags>>,
    /** LiveKit metadata of the call's participants. */
    room: {} as Record<string, VoiceModerationFlags>,
    roomServerId: null as string | null,
    /** The KickBanModal opened from a voice menu. */
    kickBan: null as null | { mode: 'kick' | 'ban'; serverId: string; user: VoiceModerationTarget },
    /** This client's row was seen in its current channel since the join. */
    seatSeen: false,
    seatChannelId: null as string | null,
    /** Consecutive polls that found the seen row gone. */
    seatMissing: 0,
  }),

  getters: {
    flagsOf: (state) => (serverId: string | null | undefined, userId: string): VoiceModerationFlags => {
      if (!serverId || !userId) return NOT_FLAGGED;
      const stored = state.byServer[serverId]?.[userId];
      const live = state.roomServerId === serverId ? state.room[userId] : undefined;
      return {
        muted: stored?.muted === true || live?.muted === true,
        deafened: stored?.deafened === true || live?.deafened === true,
      };
    },
  },

  actions: {
    async load(serverId: string | null | undefined): Promise<void> {
      if (!serverId || serverId === 'dm') return;
      try {
        const flags = await (await api()).fetchServerVoiceModeration(serverId);
        this.byServer = { ...this.byServer, [serverId]: flags };
      } catch (error) {
        debug.warn('[VoiceModeration] state unavailable:', error);
      }
    },

    apply(serverId: string, userId: string, flags: VoiceModerationFlags): void {
      const members = { ...(this.byServer[serverId] ?? {}) };
      if (flags.muted || flags.deafened) members[userId] = { muted: !!flags.muted, deafened: !!flags.deafened };
      else delete members[userId];
      this.byServer = { ...this.byServer, [serverId]: members };
    },

    setRoomFlags(serverId: string | null, userId: string, flags: VoiceModerationFlags): void {
      if (this.roomServerId !== serverId) {
        this.room = {};
        this.roomServerId = serverId;
      }
      this.room = { ...this.room, [userId]: { muted: flags.muted, deafened: flags.deafened } };
    },

    clearRoom(): void {
      this.room = {};
      this.roomServerId = null;
    },

    /**
     * What the caller may do to `targetId` in `channelId` of `serverId`, for the
     * menus. The database decides; this hides what it would refuse. As in
     * Discord, Mute, Deafen and Move Members ignore role order and apply to the
     * owner and the caller too; kick and ban need a target ranked below the
     * caller, never the owner or the caller.
     */
    async capabilities(serverId: string | null | undefined, channelId: string | null | undefined, targetId: string): Promise<VoiceModerationCapabilities> {
      if (!serverId || serverId === 'dm' || !targetId) return NO_VOICE_CAPABILITIES;
      try {
        const p = await powersOf(serverId, channelId);
        if (!p) return NO_VOICE_CAPABILITIES;
        const can = capabilitiesFrom(p);
        if (!can.kick && !can.ban) return can;
        const noRemoval = { ...can, kick: false, ban: false };
        if (p.me === targetId || targetId === p.server.owner) return noRemoval;
        if (p.me !== p.server.owner) {
          const { roleService } = await import('@/services/RoleService');
          const [mine, theirs] = await Promise.all([
            roleService.getUserRoles(p.me, serverId),
            roleService.getUserRoles(targetId, serverId),
          ]);
          if ((mine[0]?.position ?? 0) <= (theirs[0]?.position ?? 0)) return noRemoval;
        }
        return can;
      } catch (error) {
        debug.warn('[VoiceModeration] capabilities unavailable:', error);
        return NO_VOICE_CAPABILITIES;
      }
    },

    /**
     * The caller's voice moderation powers in a channel of a local server,
     * before any member's rank: which menus and drags to offer.
     */
    async channelPowers(serverId: string | null | undefined, channelId: string | null | undefined): Promise<VoiceModerationCapabilities> {
      if (!serverId || serverId === 'dm' || !channelId) return NO_VOICE_CAPABILITIES;
      try {
        const p = await powersOf(serverId, channelId);
        return p ? capabilitiesFrom(p) : NO_VOICE_CAPABILITIES;
      } catch (error) {
        debug.warn('[VoiceModeration] channel powers unavailable:', error);
        return NO_VOICE_CAPABILITIES;
      }
    },

    async setFlags(serverId: string, target: VoiceModerationTarget, flags: { mute?: boolean; deafen?: boolean }): Promise<boolean> {
      const name = target.display_name || target.username || '';
      try {
        const result = await (await api()).setServerVoiceState(serverId, target.id, flags);
        this.apply(serverId, target.id, result);
        const key = flags.mute !== undefined
          ? (flags.mute ? 'voice.moderation.mutedAnnounce' : 'voice.moderation.unmutedAnnounce')
          : (flags.deafen ? 'voice.moderation.deafenedAnnounce' : 'voice.moderation.undeafenedAnnounce');
        void say(await translate(key, { name }));
        return true;
      } catch (error) {
        void this.failed(error);
        return false;
      }
    },

    /** Moves the member to `channelId`; null disconnects. The rosters change at once. */
    async move(serverId: string, target: VoiceModerationTarget, fromChannelId: string | null, channelId: string | null): Promise<boolean> {
      const name = target.display_name || target.username || '';
      try {
        await (await api()).moveVoiceMember(serverId, target.id, channelId);
        const { serverUsers, serverChannels } = await stores();
        const rosters = { ...serverUsers.usersInVoiceChannels };
        for (const id of Object.keys(rosters)) {
          if (id === fromChannelId || rosters[id].includes(target.id)) rosters[id] = rosters[id].filter((u) => u !== target.id);
        }
        if (channelId) rosters[channelId] = [...(rosters[channelId] ?? []).filter((u) => u !== target.id), target.id];
        serverUsers.usersInVoiceChannels = rosters;
        const channel = channelId ? serverChannels.channels.find((c) => c.id === channelId)?.name ?? '' : '';
        void say(await translate(channelId ? 'voice.moderation.movedAnnounce' : 'voice.moderation.disconnectedAnnounce', { name, channel }));
        return true;
      } catch (error) {
        void this.failed(error);
        return false;
      }
    },

    openKickBan(mode: 'kick' | 'ban', serverId: string, user: VoiceModerationTarget): void {
      this.kickBan = { mode, serverId, user };
    },

    closeKickBan(): void {
      this.kickBan = null;
    },

    async failed(error: unknown): Promise<void> {
      const message = error instanceof Error && error.message ? error.message : String(error);
      const { notify } = await stores();
      notify.showToast('server_update', await translate('voice.moderation.failedTitle'), message, 6000);
    },

    // SELF

    /**
     * user:<self> voice:moved, or my_voice_state seen without a row: the member
     * leaves `fromChannelId` for `channelId`, or voice altogether.
     */
    async followDeparture(serverId: string, fromChannelId: string | null, channelId: string | null, reason: VoiceDepartureReason): Promise<void> {
      const { voice, notify, serverChannels } = await stores();
      const here = voice.currentChannelId ?? voice.optimisticChannelId;
      if (voice.currentServerId !== serverId && voice.optimisticServerId !== serverId) return;
      if (fromChannelId && here !== fromChannelId) return;
      if (channelId && here === channelId) return;
      this.resetSeat();
      if (channelId) {
        const name = serverChannels.channels.find((c) => c.id === channelId)?.name ?? '';
        const text = await translate('voice.moderation.youWereMoved', { channel: name });
        notify.showToast('server_update', await translate('voice.moderation.youWereMovedTitle'), text, 6000);
        void say(text, true);
        // A remote server's channel is joined through its host, which admits the move.
        await voice.joinVoiceChannel(channelId, serverId, voice.isFederatedChannel ? { federated: true } : { local: true });
        return;
      }
      const text = await translate(`voice.moderation.${DEPARTURE_TEXT[reason === 'moved' ? 'disconnected' : reason]}`);
      notify.showToast('server_update', await translate('voice.moderation.youWereDisconnectedTitle'), text, 6000);
      void say(text, true);
      await voice.leaveVoiceChannel();
    },

    /** Reads this client's own voice state for its call's server; follows what changed. */
    async pollSelf(): Promise<void> {
      const { voice } = await stores();
      const serverId = voice.currentServerId;
      const channelId = voice.currentChannelId;
      if (!voice.isConnected || !serverId || serverId === 'dm' || !channelId || voice.isFederatedChannel) return;
      try {
        const [mine] = await Promise.all([(await api()).fetchMyVoiceState(serverId), this.load(serverId)]);
        if (!mine || voice.currentChannelId !== channelId) return;
        const self = voice.localState.userId;
        if (self) this.apply(serverId, self, mine);
        if (this.seatChannelId !== channelId) this.resetSeat(channelId);
        if (mine.channelId === channelId) {
          this.seatSeen = true;
          this.seatMissing = 0;
          return;
        }
        if (mine.moveChannelId && mine.moveChannelId !== channelId) {
          await this.followDeparture(serverId, channelId, mine.moveChannelId, 'moved');
          return;
        }
        // Gone twice running, while realtime that would say why is down: a disconnect.
        if (this.seatSeen && !mine.channelId && !(await realtimeOnline())) {
          this.seatMissing += 1;
          if (this.seatMissing >= 2) await this.followDeparture(serverId, channelId, null, 'disconnected');
        }
      } catch (error) {
        debug.warn('[VoiceModeration] own state unavailable:', error);
      }
    },

    /**
     * A voice-grants broadcast: permissions changed for the server, `channelId`
     * or `userId` (NULL widens). Off LiveKit a client in scope re-reads SPEAK
     * and STREAM and leaves a channel that no longer admits it; on LiveKit the
     * server updates or removes its participant.
     */
    async recheckGrants(serverId: string, channelId: string | null, userId: string | null): Promise<void> {
      const { voice } = await stores();
      const here = voice.currentChannelId;
      const self = voice.localState.userId;
      if (!voice.isConnected || voice.currentServerId !== serverId || !here || !self || voice.isFederatedChannel) return;
      if ((channelId && channelId !== here) || (userId && userId !== self)) return;
      const { roleService } = await import('@/services/RoleService');
      roleService.clearServerCache(serverId);
      if (voice.connectionMode === 'livekit') return;
      try {
        const admitted = await (await api()).mayConnectVoice(here);
        if (voice.currentChannelId !== here) return;
        if (!admitted) {
          await this.followDeparture(serverId, here, null, 'revoked');
          return;
        }
        await voice.loadChannelGrants(serverId, here, self);
      } catch (error) {
        debug.warn('[VoiceModeration] grants unavailable:', error);
      }
    },

    /** Forgets the seen row: a new call, or a new channel. */
    resetSeat(channelId: string | null = null): void {
      this.seatChannelId = channelId;
      this.seatSeen = false;
      this.seatMissing = 0;
    },

    /** Polls while in a local server's call, and stops outside one. */
    async schedulePoll(): Promise<void> {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      const { voice } = await stores();
      if (!voice.isConnected || !voice.currentServerId || voice.currentServerId === 'dm' || voice.isFederatedChannel) return;
      const delay = (await realtimeOnline()) ? SELF_POLL_MS : SELF_POLL_OFFLINE_MS;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => {
        pollTimer = null;
        await this.pollSelf();
        void this.schedulePoll();
      }, delay);
    },
  },
});
