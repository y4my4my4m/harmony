<template>
  <div v-if="participants.length > 0" class="voice-participants">
    <div class="participants-header">
      <span class="participants-header-left">
        <span class="participant-count">{{ participants.length }} in call</span>
        <VoiceEncryptionBadge v-if="voiceStore.connectionMode" :encrypted="voiceStore.isEncrypted" />
      </span>
      <span v-if="sessionDuration" class="session-duration">{{ sessionDuration }}</span>
    </div>
    <div class="participants-list">
      <div
        v-for="participant in participants"
        :key="participant.userId"
        class="participant-item"
        tabindex="0"
        @contextmenu.prevent="openMenu(participant, $event.clientX, $event.clientY)"
        @keydown.shift.f10.prevent="openMenuFromKeyboard(participant, $event)"
        @keydown.context-menu.prevent="openMenuFromKeyboard(participant, $event)"
        @click="onParticipantClick(participant)"
      >
        <Avatar
          :src="getUserAvatarUrl(participant.userId).value"
          :alt="getUserDisplayName(participant.userId).value || 'User'"
          size="xs"
          :class="{ 'speaking': isSpeaking(participant) }"
        />
        <span class="participant-name"><DisplayName :userId="participant.userId" /></span>
        <div class="participant-status">
          <Icon
            v-if="isLocallyMuted(participant.userId)"
            name="volume-x"
            class="status-icon local-muted"
            size="xs"
            :title="t('voice.mutedByYou')"
          />
          <Icon v-if="participant.isMuted" name="mic-off" class="status-icon muted" size="xs" :title="t('voice.statusMuted')" />
          <Icon v-if="participant.isDeafened" name="headphones-off" class="status-icon deafened" size="xs" :title="t('voice.statusDeafened')" />
          <Icon v-if="participant.isVideoEnabled" name="video" class="status-icon video" size="xs" :title="t('voice.statusCameraOn')" />
          <span v-if="participant.isScreenSharing" class="live-pill" :title="t('voice.statusStreaming')">{{ t('voice.live') }}</span>
        </div>
      </div>
    </div>

    <VoiceUserContextMenu
      v-if="menuUser"
      :user-state="menuUser"
      :x="menuPosition.x"
      :y="menuPosition.y"
      :visible="!!menuUser"
      :source="menuUser.isScreenSharing ? 'screen' : 'camera'"
      @close="menuUser = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
import Icon from '@/components/common/Icon.vue';
import VoiceEncryptionBadge from './VoiceEncryptionBadge.vue';
import VoiceUserContextMenu from './VoiceUserContextMenu.vue';
import { useUserData } from '@/composables/useUserData';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import type { UserMediaState } from '@/services/unifiedWebRTC';

interface Props {
  participants: UserMediaState[];
  sessionStartTime: Date | null; // Kept for backwards compatibility but not used
}

const props = defineProps<Props>();

const { t } = useI18n();
const { getUserDisplayName, getUserAvatarUrl } = useUserData();
const voiceStore = useUnifiedVoiceChannelStore();

// Right-click a member for per-user volume, like Discord's channel list.
const menuUser = ref<UserMediaState | null>(null);
const menuPosition = ref({ x: 0, y: 0 });

const openMenu = (participant: UserMediaState, x: number, y: number) => {
  menuPosition.value = { x, y };
  menuUser.value = participant;
};

const openMenuFromKeyboard = (participant: UserMediaState, event: KeyboardEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(participant, rect.left + 24, rect.bottom);
};

// A live stream opens in the call view, watched.
const onParticipantClick = (participant: UserMediaState) => {
  if (!participant.isScreenSharing || participant.userId === voiceStore.localState.userId) return;
  voiceStore.watchStream(participant.userId);
  voiceStore.isOverlayVisible = true;
  voiceStore.enterFullscreen(participant.userId, 'screen');
};

const isLocallyMuted = (userId: string) =>
  userId !== voiceStore.localState.userId &&
  (voiceStore.isUserLocallyMuted(userId, 'mic') || voiceStore.getUserVolume(userId) === 0);

// The local speaking flag lives in audioLevel; remote users carry isSpeaking.
const isSpeaking = (participant: UserMediaState) => {
  if (participant.userId === voiceStore.localState.userId) {
    return voiceStore.localState.audioLevel > 20 && !voiceStore.localState.isMuted;
  }
  return participant.isSpeaking;
};

const sessionDuration = ref<string>('');
let intervalId: number | null = null;

const updateSessionDuration = () => {
  // Use callStartTime if available (overall call duration)
  // Fall back to sessionStartTime (personal session time) if callStartTime isn't set yet
  const startTime = voiceStore.callStartTime || props.sessionStartTime;
  
  if (!startTime) {
    sessionDuration.value = '';
    return;
  }

  const now = new Date();
  const diff = now.getTime() - startTime.getTime();
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  if (hours > 0) {
    sessionDuration.value = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  } else {
    sessionDuration.value = `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
};

onMounted(() => {
  updateSessionDuration();
  intervalId = window.setInterval(updateSessionDuration, 1000);
});

onUnmounted(() => {
  if (intervalId !== null) {
    clearInterval(intervalId);
  }
});
</script>

<style scoped>
.voice-participants {
  margin: 4px 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
  font-size: 12px;
}

.participants-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.participants-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.participant-count {
  color: var(--text-secondary);
  font-weight: 500;
}

.session-duration {
  color: var(--text-secondary);
  font-family: monospace;
  font-size: 11px;
}

.participants-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.participant-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.15s ease;
}

.participant-item:hover,
.participant-item:focus-visible {
  background: var(--background-modifier-hover);
  outline: none;
}

.participant-item .speaking {
  box-shadow: 0 0 0 2px var(--success);
  animation: pulse 1.5s infinite;
  border-radius: 50%;
}

@keyframes pulse {
  0%, 100% {
    box-shadow: 0 0 0 2px var(--success);
  }
  50% {
    box-shadow: 0 0 0 2px var(--success), 0 0 8px var(--success);
  }
}

@media (prefers-reduced-motion: reduce) {
  .participant-item .speaking {
    animation: none;
  }
}

:root[data-reduce-motion="true"] .participant-item .speaking {
  animation: none;
}

.live-pill {
  padding: 0 4px;
  border-radius: var(--radius-sm);
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}

.participant-name {
  flex: 1;
  color: var(--text-primary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.participant-status {
  display: flex;
  gap: 4px;
  align-items: center;
}

.status-icon {
  opacity: 0.9;
  flex-shrink: 0;
}

.status-icon.muted {
  color: var(--error);
}

.status-icon.deafened {
  color: var(--warning);
}

.status-icon.video {
  color: var(--success);
}

.status-icon.local-muted {
  color: var(--text-muted);
}

.status-icon.screen {
  color: var(--harmony-primary);
}
</style>

