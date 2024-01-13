<template>
  <div class="message-display" v-scroll-bottom>
    <div v-if="messages.length == 0">
      There are no messages here, type something!
    </div>
    <div v-else v-for="(message, index) in messages" :key="message.id" class="message-wrapper">
      <div v-if="index === 0 || messages[index - 1].user_id !== message.user_id" class="message-header">
        <img :src="getUserAvatar(message.user_id)" class="user-avatar"/>
        <div>
          <strong :style="getUserColor(message.user_id)">
            {{ getUserDisplayName(message.user_id) }} <span class="timestamp">{{ formatTimestamp(message.created_at) }}</span>
          </strong>
          <div>{{ message.content }}</div>
        </div>
      </div>
      <template v-else>
        <div class="message-content">{{ message.content }}</div>
      </template>
    </div>
  </div>
</template>


<script lang="ts">
import { defineComponent } from 'vue';
import type { PropType } from 'vue';
import type { ChatMessage } from '../types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { format } from 'date-fns';

export default defineComponent({
  props: {
    messages: {
      type: Array as PropType<ChatMessage[]>,
      required: true
    }
  },
  setup() {
    const serverUsersStore = useServerUsersStore();

    const getUserDisplayName = (userId:string) => {
      return serverUsersStore.userProfiles[userId]?.display_name || 'Unknown User';
    };
    const getUserColor = (userId:string) => {
      return `color: ${serverUsersStore.userProfiles[userId]?.color || '#dddddd'}`;
    };
    const getUserAvatar = (userId:string) => {
      return serverUsersStore.userProfiles[userId]?.avatar_url;
    };
    const formatTimestamp = (timestamp:Date) => {
      return format(new Date(timestamp), 'p'); // Formats to the user's locale time
    };
    return { getUserDisplayName, getUserColor, getUserAvatar, formatTimestamp };
  }
  
});
</script>
<style scoped>
.message-display {
  flex-grow: 1;
  overflow-y: auto;
  padding: 10px;
}

.message-wrapper {
  display: flex;
  align-items: flex-start;
}

.user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  margin-right: 10px;
}

.message-header {
  display: flex;
  margin-top: 12px;
}

.message-content {
  margin-left: 50px; /* Same as avatar width + margin-right */
}

.timestamp {
  color: #626262;
  margin-left: 8px;
  font-size: 0.8em;
}
</style>

