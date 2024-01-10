<template>
  <div class="chat-layout">
    <ServerSidebar />
    <ChannelSidebar />
    <div class="chat-area">
      <ChatCompoment />
    </div>
    <UserSidebar />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import ServerSidebar from '../components/ServerSidebar.vue';
import ChannelSidebar from '../components/ChannelSidebar.vue';
import ChatCompoment from '../components/ChatComponent.vue';
import UserSidebar from '../components/UserSidebar.vue';

export default defineComponent({
  components: {
    ServerSidebar,
    ChannelSidebar,
    ChatCompoment,
    UserSidebar
  }
});
</script>

<style scoped>
.chat-layout {
  display: flex;
  height: 100vh;
  width: 100vw; /* Ensure it takes the full viewport width */
  position: relative;
}

.chat-area {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
}

</style>
