<template>
  <div v-if="displayedSpeakers.length > 0" class="recent-speakers">
    <TransitionGroup name="speaker" tag="div" class="speakers-list">
      <div
        v-for="speaker in displayedSpeakers"
        :key="speaker.userId"
        class="speaker-item"
        :class="{ speaking: isSpeaking(speaker.userId) }"
        :title="getSpeakerName(speaker.userId)"
      >
        <Avatar
          :src="getSpeakerAvatar(speaker.userId)"
          :alt="getSpeakerName(speaker.userId)"
          size="xs"
          class="speaker-avatar"
        />
        <div v-if="isSpeaking(speaker.userId)" class="speaking-indicator">
          <span class="wave"></span>
          <span class="wave"></span>
          <span class="wave"></span>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import Avatar from '@/components/common/Avatar.vue';

interface Props {
  maxSpeakers?: number;
}

const props = withDefaults(defineProps<Props>(), {
  maxSpeakers: 5,
});

const voiceStore = useUnifiedVoiceChannelStore();
const { getUser } = useUserData();

// Get recent speakers sorted by most recent
const displayedSpeakers = computed(() => {
  return voiceStore.getRecentSpeakers.slice(0, props.maxSpeakers);
});

// Check if a user is currently speaking
const isSpeaking = (userId: string) => {
  return voiceStore.activelySpeakingUserIds.includes(userId);
};

// Get speaker's avatar URL
const getSpeakerAvatar = (userId: string) => {
  const profile = getUser(userId)?.value;
  return profile?.avatarUrl || '/default_avatar.webp';
};

// Get speaker's display name
const getSpeakerName = (userId: string) => {
  const profile = getUser(userId)?.value;
  return profile?.displayName || profile?.username || 'User';
};
</script>

<style scoped>
.recent-speakers {
  display: flex;
  align-items: center;
}

.speakers-list {
  display: flex;
  gap: 4px;
}

.speaker-item {
  position: relative;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: visible;
  transition: transform 0.2s ease;
}

.speaker-item:hover {
  transform: scale(1.1);
}

.speaker-item.speaking {
  z-index: 1;
}

.speaker-avatar {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 2px solid transparent;
  transition: border-color 0.2s ease;
}

.speaker-item.speaking .speaker-avatar {
  border-color: #00d4aa;
  box-shadow: 0 0 8px rgba(0, 212, 170, 0.5);
}

/* Speaking Indicator - Audio waves */
.speaking-indicator {
  position: absolute;
  bottom: -4px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 8px;
}

.wave {
  width: 2px;
  background: #00d4aa;
  border-radius: 1px;
  animation: wave 0.4s ease-in-out infinite;
}

.wave:nth-child(1) {
  animation-delay: 0s;
  height: 30%;
}

.wave:nth-child(2) {
  animation-delay: 0.1s;
  height: 60%;
}

.wave:nth-child(3) {
  animation-delay: 0.2s;
  height: 40%;
}

@keyframes wave {
  0%, 100% {
    transform: scaleY(1);
  }
  50% {
    transform: scaleY(1.5);
  }
}

/* Transition animations */
.speaker-enter-active,
.speaker-leave-active {
  transition: all 0.3s ease;
}

.speaker-enter-from {
  opacity: 0;
  transform: scale(0.5);
}

.speaker-leave-to {
  opacity: 0;
  transform: scale(0.5);
}

.speaker-move {
  transition: transform 0.3s ease;
}
</style>

