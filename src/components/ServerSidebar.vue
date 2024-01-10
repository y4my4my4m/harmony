<template>
    <div class="server-sidebar">
      <div v-for="server in servers" :key="server.id" class="server-item">
      {{ server.name }}
      </div>
    </div>
  </template>
  
  <script lang="ts">
  import { defineComponent, ref } from 'vue';
  
  export default defineComponent({
    setup() {
      const servers = ref([
        { id: 1, name: 'Server 1' },
        { id: 2, name: 'Server 2' },
        // Add more mock servers as needed
      ]);
  
      return { servers };
    }
  });
  </script>
  
  <style scoped>
  .server-sidebar {
    width: 72px;
    background-color: #202225;
  }
  .server-item {
    width: 64px;
    height: 64px;
    background-color: #313336;
    margin: 4px;
    padding: 4px;
    border-radius: 50%;
    text-align:center;
    vertical-align: middle;
  }
  </style>
  