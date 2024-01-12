<template>
  <div class="server-sidebar">
    <div v-for="server in servers" :key="server.id" class="server-item"
      :style="{ backgroundImage: 'url(' + server.icon + ')' }" 
      @click="selectServer(server.id)">
      <!-- {{ server.name }} -->
    </div>
  </div>
</template>

<script setup lang="ts">
  import { defineProps, defineEmits } from 'vue';
  import type { Server } from '@/types';

  defineProps({
    // make an array of type Server
    servers: {
      type: Array as () => Server[],
      required: true
    }
  });
  const emits = defineEmits(['serverSelected']);

  const selectServer = (serverId: string) => {
    emits('serverSelected', serverId);
  };
  
</script>

<style scoped>
.server-sidebar {
  width: 72px;
  background-color: #202225;
  display:flex;
  flex-direction: column;
  align-items: center;
}
.server-item {
  width: 48px;
  height: 48px;
  background-color: #313336;
  margin: 10px;
  padding: 4px;
  border-radius: 50%;
  text-align:center;
  vertical-align: middle;
  background-size: cover;
  background-position: center;
  cursor:pointer;
  position:relative;
  transition: all 0.2s ease-in-out;
  left:0;
}

.server-item::before {
  content: '';
  position: absolute;
  left: -30px;
  top: 0;
  width: 0;
  height: 0;
  border-top: 24px solid transparent;
  border-bottom: 24px solid transparent;
  border-right: 10px solid #7289da;
  border-radius: 50%;
  transition: all 0.2s ease-in-out;
}
.blob:before {
    content: "";  
    position: absolute;
    width: 50px; 
    height: 50px;
    background-color: #7491A3;
    border-radius:50%;
    top: 0;
    left: -30px;
    z-index: 1;
    transform: scale(0);
    transition: all 0.6s ease-in-out;
}

.blob:hover:before,
.blob:active:before {
    transform: scale(1);
}

.server-item:hover::before {
  width: 20px;
}
.server-item:hover{
  left:5px;
}
</style>
