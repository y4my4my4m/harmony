<template>
  <KickBanModal
    v-if="moderation.kickBan"
    :show="!!moderation.kickBan"
    :mode="moderation.kickBan.mode"
    :user="kickBanUser"
    :server-id="moderation.kickBan.serverId"
    @close="moderation.closeKickBan()"
    @done="moderation.closeKickBan()"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import KickBanModal from '@/components/moderation/KickBanModal.vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useVoiceModerationStore, type VoiceDepartureReason } from '@/stores/voiceModeration';
import { userEventChannel } from '@/services/UserEventChannel';
import { webrtcManager } from '@/services/webrtcManager';

// Voice moderation that outlives any one view: the KickBanModal a voice menu
// opens, this client's own locks and departures, and the silencing of
// server-muted participants for this listener.

const voice = useUnifiedVoiceChannelStore();
const moderation = useVoiceModerationStore();

const kickBanUser = computed(() => {
  const user = moderation.kickBan?.user;
  return {
    id: user?.id ?? '',
    username: user?.username ?? '',
    display_name: user?.display_name ?? null,
    avatar_url: user?.avatar_url ?? null,
  };
});

const REASONS: VoiceDepartureReason[] = ['moved', 'disconnected', 'removed', 'timed_out'];

let offs: Array<() => void> = [];

onMounted(() => {
  offs = [
    userEventChannel.on('voice:moderation', (data) => {
      const self = voice.localState.userId;
      if (typeof data?.server_id !== 'string' || !self) return;
      moderation.apply(data.server_id, self, { muted: data.muted === true, deafened: data.deafened === true });
    }),
    userEventChannel.on('voice:moved', (data) => {
      if (typeof data?.server_id !== 'string') return;
      const reason = REASONS.includes(data.reason) ? data.reason as VoiceDepartureReason : 'disconnected';
      void moderation.followDeparture(data.server_id, data.from_channel_id ?? null, data.channel_id ?? null, reason);
    }),
  ];
});

onBeforeUnmount(() => {
  offs.forEach((off) => off());
  offs = [];
});

// The call's server: its moderation state, and this client's own while in it.
watch(
  () => [voice.isConnected, voice.currentServerId, voice.currentChannelId] as const,
  ([connected, serverId, channelId]) => {
    if (connected && serverId) void moderation.load(serverId);
    if (!connected || moderation.seatChannelId !== channelId) moderation.resetSeat(connected ? channelId : null);
    void moderation.schedulePoll();
  },
  { immediate: true },
);

// Off LiveKit (P2P) SPEAK and STREAM come from the caller's channel permissions.
watch(
  () => [voice.isConnected, voice.currentServerId, voice.currentChannelId, voice.connectionMode, voice.isFederatedChannel] as const,
  ([connected, serverId, channelId, mode, federated]) => {
    if (!connected || !serverId || serverId === 'dm' || !channelId || mode === 'livekit' || federated) return;
    void voice.loadChannelGrants(serverId, channelId, voice.localState.userId);
  },
  { immediate: true },
);

watch(
  () => [voice.isConnected, voice.speakLocked, voice.deafenLocked, voice.canStream] as const,
  () => { void voice.enforceVoiceLocks(); },
  { immediate: true },
);

// A server-muted participant plays at 0 here whatever the transport.
const silenced = computed(() => {
  const serverId = voice.currentServerId;
  if (!voice.isConnected || !serverId) return [] as string[];
  return voice.allUsers
    .filter((u) => {
      const flags = moderation.flagsOf(serverId, u.userId);
      return flags.muted || flags.deafened;
    })
    .map((u) => u.userId);
});

watch(silenced, (now, before) => {
  for (const userId of before ?? []) if (!now.includes(userId)) webrtcManager.setUserSilenced(userId, false);
  for (const userId of now) webrtcManager.setUserSilenced(userId, true);
}, { immediate: true });
</script>
