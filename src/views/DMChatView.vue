<template>
  <div class="dm-layout">
    <!-- DM Sidebar -->
    <DMSidebar class="dm-sidebar-component" />
    
    <!-- Main DM Content -->
    <div class="dm-main-content">
      <DMView :conversationId="conversationId" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import DMSidebar from '@/components/DMSidebar.vue'
import DMView from '@/components/DMView.vue'

const route = useRoute()

const conversationId = computed(() => {
  const id = route.params.conversationId
  return typeof id === 'string' ? id : undefined
})
</script>

<style scoped>
.dm-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  background: var(--h-chat);
}

.dm-sidebar-component {
  flex-shrink: 0;
}

.dm-main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .dm-layout {
    flex-direction: column;
  }
  
  .dm-sidebar-component {
    height: auto;
    max-height: 40vh;
    overflow-y: auto;
  }
  
  .dm-main-content {
    flex: 1;
    min-height: 0;
  }
}
</style>