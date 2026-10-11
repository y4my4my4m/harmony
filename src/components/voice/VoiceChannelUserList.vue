<template>
  <div v-if="userIds.length > 0" class="voice-channel-users">
    <div class="users-header">
      <span :id="headerId" class="user-count">{{ t('voice.inCallCount', { count: userIds.length }, userIds.length) }}</span>
      <span v-if="callDuration" class="call-duration">
        <span class="sr-only">{{ t('voice.callDuration') }} </span>{{ callDuration }}
      </span>
    </div>
    <ul class="users-list" :aria-labelledby="headerId">
      <li v-for="userId in userIds" :key="userId" class="user-item" :data-testid="`voice-roster-${userId}`">
        <Avatar
          :src="getUserAvatarUrl(userId).value"
          alt=""
          size="xs"
        />
        <span class="user-name"><DisplayName :userId="userId" /></span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
import { useUserData } from '@/composables/useUserData';
import { useT } from '@/composables/useT';
import { uid } from '@/utils/a11y/focus';

interface Props {
  userIds: string[];
  callStartTime?: Date | null;
}

const props = defineProps<Props>();

const { getUserAvatarUrl } = useUserData();
const { t } = useT();
const headerId = uid('voice-roster-header');

const callDuration = ref<string>('');
let intervalId: number | null = null;

const updateCallDuration = () => {
  if (!props.callStartTime) {
    callDuration.value = '';
    return;
  }

  const now = new Date();
  const diff = now.getTime() - props.callStartTime.getTime();
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  if (hours > 0) {
    callDuration.value = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  } else {
    callDuration.value = `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
};

onMounted(() => {
  updateCallDuration();
  intervalId = window.setInterval(updateCallDuration, 1000);
});

onUnmounted(() => {
  if (intervalId !== null) {
    clearInterval(intervalId);
  }
});
</script>

<style scoped>
.voice-channel-users {
  margin: 4px 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
  font-size: 12px;
}

.users-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.user-count {
  color: var(--text-secondary);
  font-weight: 500;
}

.call-duration {
  color: var(--text-secondary);
  font-family: monospace;
  font-size: 11px;
}

.users-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.user-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.15s ease;
}

.user-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.user-name {
  flex: 1;
  color: var(--text-primary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

