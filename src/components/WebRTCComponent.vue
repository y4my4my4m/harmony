<!-- // src/components/MyWebRTCComponent.vue

<template>
</template>

<script lang="ts">
import { defineComponent, onMounted } from 'vue';
import { connectToMediasoupServer } from '@/services/webrtc';

export default defineComponent({
  setup() {
    onMounted(async () => {
      // Establish a connection to the mediasoup server when the component is mounted
      const transport = await connectToMediasoupServer();

      // Use the transport and handle WebRTC communication in your component
      // For example, start a video call or add event listeners for incoming data
    });
  },
});
</script> -->
