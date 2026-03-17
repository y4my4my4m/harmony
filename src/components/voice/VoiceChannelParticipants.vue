<template>
  <div v-if="participants.length > 0" class="voice-participants">
    <div class="participants-header">
      <span class="participant-count">{{ participants.length }} in call</span>
      <span v-if="sessionDuration" class="session-duration">{{ sessionDuration }}</span>
    </div>
    <div class="participants-list">
      <div v-for="participant in participants" :key="participant.userId" class="participant-item">
        <Avatar
          :src="getUserAvatarUrl(participant.userId).value"
          :alt="getUserDisplayName(participant.userId).value || 'User'"
          size="xs"
          :class="{ 'speaking': participant.isSpeaking }"
        />
        <span class="participant-name"><DisplayName :userId="participant.userId" /></span>
        <div class="participant-status">
          <Icon v-if="participant.isMuted" name="mic-off" class="status-icon muted" size="xs" title="Muted" />
          <Icon v-if="participant.isDeafened" name="headphones-off" class="status-icon deafened" size="xs" title="Deafened" />
          <Icon v-if="participant.isVideoEnabled" name="video" class="status-icon video" size="xs" title="Video On" />
          <Icon v-if="participant.isScreenSharing" name="screen-share" class="status-icon screen" size="xs" title="Screen Sharing" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
import Icon from '@/components/common/Icon.vue';
import { useUserData } from '@/composables/useUserData';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import type { UserMediaState } from '@/services/unifiedWebRTC';

interface Props {
  participants: UserMediaState[];
  sessionStartTime: Date | null; // Kept for backwards compatibility but not used
}

const props = defineProps<Props>();

const { getUserDisplayName, getUserAvatarUrl } = useUserData();
const voiceStore = useUnifiedVoiceChannelStore();

// Call duration timer (tracks overall call duration)
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

.participant-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.participant-item .speaking {
  box-shadow: 0 0 0 2px #43b581;
  animation: pulse 1.5s infinite;
  border-radius: 50%;
}

@keyframes pulse {
  0%, 100% {
    box-shadow: 0 0 0 2px #43b581;
  }
  50% {
    box-shadow: 0 0 0 2px #43b581, 0 0 8px #43b581;
  }
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
  color: #f04747;
}

.status-icon.deafened {
  color: #faa61a;
}

.status-icon.video {
  color: #43b581;
}

.status-icon.screen {
  color: #0EA5E9;
}
</style>

