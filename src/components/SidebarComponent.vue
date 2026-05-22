<template>
  <div class="sidebar">
    <ul>
      <li v-for="room in chatRooms" :key="room.id">{{ room.name }}</li>
    </ul>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import type { Ref } from 'vue';
// `ChatRoom` was removed from `@/types`; use a loose placeholder type so the
// component compiles without resurrecting the legacy interface.
type ChatRoom = { id: string; name?: string };

export default defineComponent({
  name: 'SidebarComponent',
  setup() {
    const chatRooms: Ref<ChatRoom[]> = ref([]);

    // Implement logic to fetch and populate chat rooms

    return { chatRooms };
  }
});
</script>

<style scoped>
/* Add styles for your sidebar component here */
</style>
