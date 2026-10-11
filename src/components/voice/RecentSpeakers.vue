<template>
  <div v-if="displayedSpeakers.length > 0" class="recent-speakers">
    <TransitionGroup name="speaker" tag="ul" class="speakers-list" :aria-label="t('voice.recentSpeakers')">
      <li
        v-for="speaker in displayedSpeakers"
        :key="speaker.userId"
        class="speaker-item"
        :class="{ speaking: isSpeaking(speaker.userId) }"
        :title="getSpeakerName(speaker.userId)"
      >
        <Avatar
          :src="getSpeakerAvatar(speaker.userId)"
          alt=""
          size="xs"
          class="speaker-avatar"
        />
        <span class="sr-only">{{ speakerLabel(speaker.userId) }}</span>
        <div v-if="isSpeaking(speaker.userId)" class="speaking-indicator" aria-hidden="true">
          <span class="wave"></span>
          <span class="wave"></span>
          <span class="wave"></span>
        </div>
      </li>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import Avatar from '@/components/common/Avatar.vue';
import { useT } from '@/composables/useT';
import { participantLabel, useHeldIds } from './participantLabel';

interface Props {
  maxSpeakers?: number;
}

const props = withDefaults(defineProps<Props>(), {
  maxSpeakers: 5,
});

const voiceStore = useUnifiedVoiceChannelStore();
const { getUser } = useUserData();
const { t } = useT();
const speakingIds = useHeldIds(() => voiceStore.activelySpeakingUserIds);

const displayedSpeakers = computed(() => {
  return voiceStore.getRecentSpeakers.slice(0, props.maxSpeakers);
});

const isSpeaking = (userId: string) => {
  return voiceStore.activelySpeakingUserIds.includes(userId);
};

const getSpeakerAvatar = (userId: string) => {
  const profile = getUser(userId)?.value;
  return profile?.avatarUrl || '/default_avatar.webp';
};

const getSpeakerName = (userId: string) => {
  const profile = getUser(userId)?.value;
  return profile?.displayName || profile?.username || 'User';
};

const speakerLabel = (userId: string) =>
  participantLabel(t, getSpeakerName(userId), { speaking: speakingIds.value.has(userId) });
</script>

<style scoped>
.recent-speakers {
  display: flex;
  align-items: center;
}

.speakers-list {
  display: flex;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
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

