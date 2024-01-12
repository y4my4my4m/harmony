<template>
  <div class="message-display">
    <div v-for="message in messages" :key="message.id" class="message">
      <strong>{{ getUserDisplayName(message.user_id) }}:</strong> {{ message.content }}
    </div>
  </div>
</template>
  

<script lang="ts">
import { defineComponent } from 'vue';
import type { PropType } from 'vue';
import type { ChatMessage } from '../types';
import { useServerUsersStore } from '@/stores/useServerUsers';

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

    return { getUserDisplayName };
  }
});
</script>
<style scoped>
.message-display {
  flex-grow: 1;
  overflow-y: auto;
  /* additional styling */
}
</style>
